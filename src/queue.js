export function createSerialQueue() {
  let tail = Promise.resolve();
  let size = 0;
  return {
    enqueue(taskFn) {
      size += 1;
      const run = tail.then(taskFn, taskFn); // run regardless of prior outcome
      // advance tail without propagating rejection into the chain
      tail = run.then(() => { size -= 1; }, () => { size -= 1; });
      return run;
    },
    get size() { return size; },
  };
}
