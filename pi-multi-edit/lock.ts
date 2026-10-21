// Serialize async read-modify-write operations per absolute file path.
//
// Parallel edit calls to the same file otherwise interleave their
// read -> apply -> write cycle: both read the same original content and the
// later full-file write overwrites the earlier one, silently dropping an edit
// while both report success. Keying the lock by absolute path keeps edits to
// *different* files fully parallel while forcing same-file edits to run one
// at a time (the second reads the file after the first has written it).

const tails = new Map<string, Promise<void>>();

export function withFileLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = tails.get(key) ?? Promise.resolve();
  const run = prev.then(() => fn());
  // Store a non-rejecting tail so one failed operation does not wedge the
  // queue for later operations on the same path.
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  tails.set(key, tail);
  // Drop the map entry once this is the last queued operation for the path.
  void tail.then(() => {
    if (tails.get(key) === tail) tails.delete(key);
  });
  return run;
}
