'use strict';

var fs = require('graceful-fs');
var path = require('path');
var extend = require('extend');
var errcode = require('err-code');
var retry = require('retry');
var async = require('async');
var uuid = require('uuid');

var locks = {};

function getLockFile(file) {
    return file + '.lock';
}

function getUidFile(file) {
    return path.join(getLockFile(file), '.uid');
}

function canonicalPath(file, options, callback) {
    if (!options.resolve) {
        return callback(null, path.normalize(file));
    }

    options.fs.realpath(file, callback);
}

function acquireLock(file, options, callback) {
    // Fast fail if a lock is acquired here
    if (locks[file]) {
        return callback(errcode('Lock file is already being hold', 'ELOCKED', { file: file }));
    }

    // Use mkdir to create the lockfile (atomic operation)
    options.fs.mkdir(getLockFile(file), function (err) {
        var uid;

        // If we successfuly created the lockfile,
        // write the uidfile and we are done
        if (!err) {
            uid = uuid.v4();
            return options.fs.writeFile(getUidFile(file), uid, function (err) {
                if (err) {
                    return removeLock(file, options, function () {
                        callback(err);
                    });
                }

                return callback(null, uid);
            });
        }

        // Otherwise, check if lock is stale by analyzing the file mtime
        if (options.stale <= 0) {
            return callback(errcode('Lock file is already being hold', 'ELOCKED', { file: file }));
        }

        options.fs.stat(getLockFile(file), function (err, stat) {
            if (err) {
                // Retry if the lockfile has been removed (meanwhile)
                // Skip stale check to avoid recursiveness
                if (err.code === 'ENOENT') {
                    return acquireLock(file, extend({}, options, { stale: 0 }), callback);
                }

                return callback(err);
            }

            if (stat.mtime.getTime() >= Date.now() - options.stale) {
                return callback(errcode('Lock file is already being hold', 'ELOCKED', { file: file }));
            }

            // If it's stale, remove it and try again!
            // Skip stale check to avoid recursiveness
            removeLock(file, options, function (err) {
                if (err) {
                    return callback(err);
                }

                acquireLock(file, extend({}, options, { stale: 0 }), callback);
            });
        });
    });
}

function removeLock(file, options, callback) {
    // Remove uidfile, ignoring ENOENT errors
    options.fs.unlink(getUidFile(file), function (err) {
        if (err && err.code !== 'ENOENT') {
            return callback(err);
        }

        // Remove lockfile, ignoring ENOENT errors
        options.fs.rmdir(getLockFile(file), function (err) {
            if (err && err.code !== 'ENOENT') {
                return callback(err);
            }

            callback();
        });
    });
}

function updateLock(file, options) {
    var lock = locks[file];

    lock.updateDelay = lock.updateDelay || options.update;
    lock.updateTimeout = setTimeout(function () {
        var mtime = Date.now() / 1000;

        lock.updateTimeout = null;

        async.parallel({
            read: options.fs.readFile.bind(options.fs, getUidFile(file)),
            utimes: options.fs.utimes.bind(options.fs, getLockFile(file), mtime, mtime),
        }, function (err, result) {
            // Ignore if the lock was released
            if (lock.released) {
                return;
            }

            // Verify if we are within the stale threshold
            if (lock.lastUpdate <= Date.now() - options.stale) {
                return unlock(file, extend({}, options, { resolve: false }), function () {
                    lock.compromised(lock.updateError || errcode('Unable to update lock within the stale threshold', 'EUPDATE'));
                });
            }

            // If it failed to update the lockfile, keep trying unless
            // the lockfile/uidfile was deleted!
            if (err) {
                if (err.code === 'ENOENT') {
                    return unlock(file, extend({}, options, { resolve: false }), function () {
                        lock.compromised(err);
                    });
                }

                lock.updateError = err;
                lock.updateDelay = 1000;
                return updateLock(file, options);
            }

            // Verify lock uid
            if (result.read.toString().trim() !== lock.uid) {
                lock.released = true;
                delete locks[file];
                return lock.compromised(errcode('Lock uid mismatch', 'EMISMATCH'));
            }

            // All ok, keep updating..
            lock.lastUpdate = Date.now();
            lock.updateError = null;
            lock.updateDelay = null;
            updateLock(file, options);
        });
    }, lock.updateDelay);
}

// -----------------------------------------

function lock(file, options, compromised, callback) {
    if (typeof options === 'function') {
        callback = compromised;
        compromised = options;
        options = null;
    }

    if (!callback) {
        callback = compromised;
        compromised = null;
    }

    options = extend({
        stale: 10000,   // 10 secs
        update: 5000,   // 5 secs
        resolve: true,
        retries: 0,
        fs: fs
    }, options);

    options.retries = options.retries || 0;
    options.retries = typeof options.retries === 'number' ? { retries: options.retries } : options.retries;
    options.stale = Math.max(options.stale || 0, 2000);
    options.update = Math.max(Math.min(options.update || 0, Math.round(options.stale / 2)), 1000);
    compromised = compromised || function (err) { throw err; };

    // Resolve to a canonical file path
    canonicalPath(file, options, function (err, file) {
        var operation;

        if (err) {
            return callback(err);
        }

        // Attempt to acquire the lock
        operation = retry.operation(options.retries);
        operation.attempt(function () {
            acquireLock(file, options, function (err, uid) {
                var lock;

                if (operation.retry(err)) {
                    return;
                }

                if (err) {
                    return callback(operation.mainError());
                }

                // We now own the lock
                locks[file] = lock = {
                    uid: uid,
                    options: options,
                    compromised: compromised,
                    lastUpdate: Date.now()
                };

                // We must keep the lock fresh to avoid staleness
                updateLock(file, options);

                callback(null, function (releasedCallback) {
                    releasedCallback = releasedCallback || function () {};

                    if (lock.released) {
                        return releasedCallback(errcode('Lock is already released', 'ERELEASED'));
                    }

                    // Not necessary to resolve twice when unlocking
                    unlock(file, extend({}, options, { resolve: false }), releasedCallback);
                });
            });
        });
    });
}

function unlock(file, options, callback) {
    if (typeof options === 'function') {
        callback = options;
        options = null;
    }

    options = extend({
        fs: fs,
        resolve: true
    }, options);

    callback = callback || function () {};

    // Resolve to a canonical file path
    canonicalPath(file, options, function (err, file) {
        var lock;

        if (err) {
            return callback(err);
        }

        // Skip if the lock is not acquired
        lock = locks[file];
        if (!lock) {
            return callback(errcode('Lock is not acquired', 'ENOTACQUIRED'));
        }

        lock.updateTimeout && clearTimeout(lock.updateTimeout);  // Cancel lock mtime update
        lock.released = true;                                    // Signal the lock has been released
        delete locks[file];                                   // Delete from acquired

        removeLock(file, options, callback);
    });
}

// Remove acquired locks on exit
/* istanbul ignore next */
process.on('exit', function () {
    Object.keys(locks).forEach(function (file) {
        try {
            locks[file].options.fs.unlinkSync.sync(getUidFile(file));
            locks[file].options.fs.rmdirSync.sync(getLockFile(file));
        } catch (e) {}
    });
});

module.exports = lock;
module.exports.lock = lock;
module.exports.unlock = unlock;
