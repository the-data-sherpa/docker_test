exports.name = 'Sort';
exports.version = '0.1';
exports.disabled = false;
exports.handleSignals = true;
exports.group = C.INTERNAL_FUNCTION_GROUP;

const { Expression } = C.expr;
const logger = C.util.getLogger('func:sort');
const SORT_MAX_EVENTS_IN_MEMORY = C.kusto.SORT_MAX_EVENTS_IN_MEMORY;
const SORT_FLUSH_INTERVAL = 500;

let sortProvider; // used as sort engine for all events
let hadFinal;     // indicator that we have seen the final event (and can skip everything else)
let checkFlush;   // true if it is time to flush a preview (every SORT_FLUSH_INTERVAL ms)
let lastFlush;    // time of last flush
let previewCount; // number of intermediate previews (for diag message)
let timeToFinal;  // time from the first to the last event (for diag message)

/**
 * Initialize the sort provider, used by this pipeline function.
 * @param {*} opts The information for the {@link SortConfig}.
 */
exports.init = (opts) => {
  const conf = opts.conf;

  if (conf.comparisonExpression) {
    const expr = new Expression(conf.comparisonExpression, { disallowAssign: true });
    const compFunc = (left, right) => {
      try {
        return expr.evalOn({ left: left, right: right });
      } catch (err) {
        logger.warn('error during sort comparison', { error: err, left: left, right: right });
        return 0;
      }
    };

    if (!(conf.topN < SORT_MAX_EVENTS_IN_MEMORY || conf.maxEvents < SORT_MAX_EVENTS_IN_MEMORY)) {
      // we'll enable MergeSort in future version (allowing for larger sorts)
      conf.topN = SORT_MAX_EVENTS_IN_MEMORY;
      logger.warn('applying implicit topN to sort', { conf: conf });
    }

    const sortConf = {
      id: conf.sortId ?? `sort-${Date.now()}`,
      compareFunction: compFunc,
    };

    if (conf.topN) sortConf.topN = conf.topN;
    if (conf.maxEvents) sortConf.maxEvents = conf.maxEvents;

    sortProvider = C.kusto.createSort(sortConf);
    hadFinal = false;
    checkFlush = true;
    lastFlush = 0;
    previewCount = 0;

    logger.debug('created sort provider', { id: sortProvider.conf.id, type: sortProvider.type });
  } else {
    throw new Error('No comparison expression on sort configuration');
  }
};

/**
 * Processes a single input event, as source for a sort.
 * @param {*} event The event to add to the sort provider
 * @returns The source provider output or null
 */
exports.process = async (event) => {
  if (!event || (hadFinal && event.__signalEvent__ !== 'reset')) return event; // quick out for invalid events

  if (event.__signalEvent__) {
    switch (event.__signalEvent__) {
      case 'timer': {
        checkFlush = true;
        if (event.__ctrlFields?.includes('force')) {
          // force the preview (used in UT)
          lastFlush = Date.now() - (SORT_FLUSH_INTERVAL + 1);
        }

        const ret = checkFlushInterval();
        if (ret?.length) {
          // we got a preview here
          return [event, ...ret];
        }

        return event;
      }

      case 'reset':
        logger.debug('resetting sort storage', { id: sortProvider.conf.id });
        sortProvider.reset();
        hadFinal = false;
        return event;

      case 'final':
        // skip the finals that are caused by limit/take
        if (event.__ctrlFields.includes('cancel')) return event;
        hadFinal = true;

        // future version will return the drainable (the generator) directly back
        // into the pipeline. for now, supporting only small sort results, we drain
        // the sort output into an array here.
        const drained = [];
        for await (const e of sortProvider.drain()) {
          drained.push(e);
        }

        // we didn't have anything in the sort output, quick return here
        if (!drained.length) return event;

        const resetEvent = event.__clone(false, []);
        resetEvent.__signalEvent__ = 'reset';
        resetEvent.__setCtrlField('sort', 'final'); // mark this reset source for debugging

        // return [reset, <...sorted data...>, final]
        drained.unshift(resetEvent);
        drained.push(event); // the final signal

        timeToFinal = Date.now() - timeToFinal;
        logger.debug('done with sort (received final event)', {
          id: sortProvider.conf.id,
          stats: sortProvider.sortStats,
          previews: previewCount,
          totalTime: timeToFinal,
        });
  
        return drained;

      default:
        return event; // unhandled signal event
    }
  }

  // not a signal event, add it to the sort engine
  await sortProvider.addEvent(event);
  return checkFlushInterval(); // check if we can return a preview
};

/**
 * Helper to check if we should flush a sort preview.
 * We check if a preview needs to be flushed all SORT_FLUSH_INTERVAL milliseconds.
 * @returns The preview if it was time to flush or null otherwise
 */
function checkFlushInterval() {
  let ret = null;

  if (checkFlush && !hadFinal) {
    const now = Date.now();
    checkFlush = false;

    let delayNextCheckMs = SORT_FLUSH_INTERVAL;
    if (lastFlush) {
      const since = now - lastFlush;
      if (since > SORT_FLUSH_INTERVAL) {
        // time to flush, return [reset, <...sorted preview...>]
        ret = sortProvider.preview();
        if (ret.length) {
          const resetEvent = ret[0].__clone(false, []);
          resetEvent.__signalEvent__ = 'reset';
          resetEvent.__setCtrlField('sort', 'preview'); // marking for debugging
          ret.unshift(resetEvent);
        }

        lastFlush = now;
        ++previewCount;

        logger.debug('created sorted preview', {
          id: sortProvider.conf.id,
          events: ret.length - 1,
          previews: previewCount,
        });
      } else {
        // too early (i.e. timer signal event)
        delayNextCheckMs = SORT_FLUSH_INTERVAL - since;
      }
    } else {
      // initializing lastFlush with first event
      lastFlush = now;
      timeToFinal = now;
    }

    // lets check in nextTimer milliseconds again
    setTimeout(() => (checkFlush = true), delayNextCheckMs);
  }

  return ret?.length ? ret : null;
}

/**
 * Clean up on UnLoad.
 */
exports.unload = () => {
  logger.debug('unloading sort function', { id: sortProvider.conf.id });
  sortProvider.reset();
};
