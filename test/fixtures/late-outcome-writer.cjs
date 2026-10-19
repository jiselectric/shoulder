// Loaded only in a disposable regression launcher before Node lazily imports
// internal/fs/rimraf. Cause a real ENOTEMPTY at its final directory removal,
// modeling the main helper's late outcome temp-file/rename after kill-server.
const fs = require('node:fs');
const path = require('node:path');
const marker = process.env.SHOULDER_TEST_LATE_OUTCOME_MARKER;
if (marker) {
  const original = fs.rmdir;
  let target, attempts = 0;
  fs.rmdir = function (directory, ...args) {
    const name = String(directory);
    if (!target && /^\/tmp\/shoulder-result-[^/]+$/.test(name)) target = name;
    if (name === target) {
      attempts++;
      if (attempts === 1) {
        // The first rmdir must enter rimraf's child-enumeration path.
        fs.writeFileSync(path.join(name, 'enumeration-seed'), 'synthetic');
      } else if (attempts === 2) {
        // Enumeration has finished. Introduce a finite late writer before the
        // real OS rmdir, rather than fabricating an error or delaying a test.
        const temporary = path.join(name, 'late-main.json.tmp');
        fs.writeFileSync(temporary, '{"exitCode":0}');
        fs.renameSync(temporary, path.join(name, 'late-main.json'));
        const callback = args.pop();
        args.push((error, ...result) => {
          fs.appendFileSync(marker, JSON.stringify({ directory: name, code: error?.code, attempt: attempts }) + '\n');
          callback(error, ...result);
        });
      }
    }
    return original.call(this, directory, ...args);
  };
}
