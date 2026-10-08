'use strict';
import('./server.js').catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
