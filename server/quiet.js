// node:sqlite is still flagged experimental and would print a warning on every launch.
// Swallow only that one; leave every other warning alone.
const orig = process.emitWarning;
process.emitWarning = function (warning, ...args) {
  const type = typeof args[0] === 'string' ? args[0] : args[0]?.type;
  if (type === 'ExperimentalWarning' && /SQLite/i.test(String(warning?.message ?? warning))) return;
  return orig.call(process, warning, ...args);
};
