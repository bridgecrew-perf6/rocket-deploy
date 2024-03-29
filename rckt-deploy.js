"use strict";

const chalk = require('chalk');

const upath = require("upath");
const util = require("util");
const events = require("events");
const Promise = require("bluebird");
const fs = require("fs");
const path = require("path");

const minimatch = require("minimatch");
const read = require("read");
const readP = util.promisify(read);

const PromiseFtp = require("promise-ftp");
const PromiseSftp = require("ssh2-sftp-client");


const root = path.resolve(__dirname, '../../');
const rawConfig = fs.readFileSync(`${root}/.rckt-deploy.json`);

const config = {
    user: "",
    password: "",
    host: "",
    port: 21,
    localRoot: root + "/",
    remoteRoot: "/",
    include: ["*"],
    exclude: [], //will be pushed
    deleteRemote: true,
    forcePasv: true,
    sftp: false
};
Object.assign(config, JSON.parse(rawConfig));
config.exclude.push(...[
    "dist/**/*.map",
    "node_modules/**",
    "node_modules/**/.*",
    ".git/**",
    ".rckt-deploy.json"
]);

const lib = {
    checkIncludes(config) {
        config.excludes = config.excludes || [];
        if (!config.include || !config.include.length) {
            return Promise.reject({
                code: "NoIncludes",
                message: "You need to specify files to upload - e.g. ['*', '**/*']"
            });
        } else {
            return Promise.resolve(config);
        }
    },

    getPassword(config) {
        if (config.password) {
            return Promise.resolve(config);
        } else {
            let options = {
                prompt: `Password for ${config.user}@${config.host} (ENTER for none): `,
                default: "",
                silent: true
            };
            return readP(options).then(res => {
                let config2 = Object.assign(config, { password: res });
                return config2;
            });
        }
    },

    // Analysing local firstory

    canIncludePath(includes, excludes, filePath) {
        let go = (acc, item) =>
            acc || minimatch(filePath, item, { matchBase: true });
        let canInclude = includes.reduce(go, false);

        // Now check whether the file should in fact be specifically excluded
        if (canInclude) {
            // if any excludes match return false
            if (excludes) {
                let go2 = (acc, item) =>
                    acc && !minimatch(filePath, item, { matchBase: true });
                canInclude = excludes.reduce(go2, true);
            }
        }

        return canInclude;
    },

    // A method for parsing the source location and storing the information into a suitably formated object
    parseLocal(includes, excludes, localRootDir, relDir) {
        // reducer
        let handleItem = function (acc, item) {
            const currItem = path.join(fullDir, item);
            const newRelDir = path.relative(localRootDir, currItem);

            if (fs.lstatSync(currItem).isDirectory()) {
                // currItem is a directory. Recurse and attach to accumulator
                let tmp = lib.parseLocal(includes, excludes, localRootDir, newRelDir);
                for (let key in tmp) {
                    if (tmp[key].length == 0) {
                        delete tmp[key];
                    }
                }
                return Object.assign(acc, tmp);
            } else {
                // currItem is a file
                // acc[relDir] is always created at previous iteration
                if (lib.canIncludePath(includes, excludes, newRelDir)) {
                    console.log("including", currItem);
                    acc[relDir].push(item);
                    return acc;
                }
            }
            return acc;
        };

        const fullDir = path.join(localRootDir, relDir);
        // Check if `startDir` is a valid location
        if (!fs.existsSync(fullDir)) {
            throw new Error(fullDir + " is not an existing location");
        }

        // Iterate through the contents of the `fullDir` of the current iteration
        const files = fs.readdirSync(fullDir);
        // Add empty array, which may get overwritten by subsequent iterations
        let acc = {};
        acc[relDir] = [];
        const res = files.reduce(handleItem, acc);
        return res;
    },

    countFiles(filemap) {
        return Object.values(filemap).reduce((acc, item) => acc.concat(item))
            .length;
    },

    deleteDir(ftp, dir) {
        return ftp.list(dir).then(lst => {
            let dirNames = lst
                .filter(f => f.type == "d" && f.name != ".." && f.name != ".")
                .map(f => path.posix.join(dir, f.name));

            let fnames = lst
                .filter(f => f.type != "d")
                .map(f => path.posix.join(dir, f.name));

            // delete sub-directories and then all files
            return Promise.mapSeries(dirNames, dirName => {
                // deletes everything in sub-directory, and then itself
                return deleteDir(ftp, dirName).then(() => ftp.rmdir(dirName));
            }).then(() => Promise.mapSeries(fnames, fname => ftp.delete(fname)));
        });
    },

    mkDirExists(ftp, dir) {
        // Make the directory using recursive expand
        return ftp.mkdir(dir, true).catch(err => {
            if (err.message.startsWith("EEXIST")) {
                return Promise.resolve();
            } else {
                console.log("[mkDirExists]", err.message);
                // console.log(Object.getOwnPropertyNames(err));
                return Promise.reject(err);
            }
        });
    }
}

class FtpDeployer {
    constructor() {
        this.ftp = null;
        this.eventObject = {
            totalFilesCount: 0,
            transferredFileCount: 0,
            filename: "",
        }

        return this;
    }

    makeAllAndUpload(remoteDir, filemap) {
        let keys = Object.keys(filemap);
        return Promise.mapSeries(keys, (key) => {
            // console.log("Processing", key, filemap[key]);
            return this.makeAndUpload(remoteDir, key, filemap[key]);
        });
    }

    makeDir(newDirectory) {
        if (newDirectory === "/") {
            return Promise.resolve("unused");
        } else {
            return this.ftp.mkdir(newDirectory, true);
        }
    }

    makeAndUpload(config, relDir, fnames) {
        let newDirectory = upath.join(config.remoteRoot, relDir);
        return this.makeDir(newDirectory, true).then(() => {
            // console.log("newDirectory", newDirectory);
            return Promise.mapSeries(fnames, (fname) => {
                let tmpFileName = upath.join(config.localRoot, relDir, fname);
                let tmp = fs.readFileSync(tmpFileName);
                this.eventObject["filename"] = upath.join(relDir, fname);

                this.emit("uploading", this.eventObject);

                return this.ftp
                    .put(tmp, upath.join(config.remoteRoot, relDir, fname))
                    .then(() => {
                        this.eventObject.transferredFileCount++;
                        this.emit("uploaded", this.eventObject);
                        return Promise.resolve("uploaded " + tmpFileName);
                    })
                    .catch((err) => {
                        this.eventObject["error"] = err;
                        this.emit("upload-error", this.eventObject);
                        // if continue on error....
                        return Promise.reject(err);
                    });
            });
        });
    }

    connect(config) {
        this.ftp = config.sftp ? new PromiseSftp() : new PromiseFtp();

        // sftp client does not provide a connection status
        // so instead provide one ourselfs
        if (config.sftp) {
            this.connectionStatus = "disconnected";
            this.ftp.on("end", this.handleDisconnect);
            this.ftp.on("close", this.handleDisconnect);
        }

        return this.ftp
            .connect(config)
            .then((serverMessage) => {
                console.log(chalk.yellow(`Connected to: ${config.host}`));

                if (config.sftp) {
                    this.connectionStatus = "connected";
                }

                return config;
            })
            .catch((err) => {
                return Promise.reject({
                    code: err.code,
                    message: "connect: " + err.message,
                });
            });
    }

    getConnectionStatus() {
        // only ftp client provides connection status
        // sftp client connection status is handled using events
        return typeof this.ftp.getConnectionStatus === "function"
            ? this.ftp.getConnectionStatus()
            : this.connectionStatus;
    }

    handleDisconnect() {
        this.connectionStatus = "disconnected";
    }

    checkLocalAndUpload(config) {
        try {
            let filemap = lib.parseLocal(
                config.include,
                config.exclude,
                config.localRoot,
                "/"
            );
            this.eventObject["totalFilesCount"] = lib.countFiles(filemap);
            console.log(chalk.yellow(`Files found to upload: ${this.eventObject["totalFilesCount"]}`));

            return this.makeAllAndUpload(config, filemap);
        } catch (e) {
            return Promise.reject(e);
        }
    }

    deleteRemote(config) {
        if (config.deleteRemote) {
            return lib
                .deleteDir(this.ftp, config.remoteRoot)
                .then(() => {
                    return config;
                })
                .catch((err) => {
                    return Promise.resolve(config);
                });
        }
        return Promise.resolve(config);
    }

    deploy(config, cb) {
        return lib
            .checkIncludes(config)
            .then(lib.getPassword)
            .then(config => this.connect(config))
            .then(config => this.deleteRemote(config))
            .then(config => this.checkLocalAndUpload(config))
            .then((res) => {
                this.ftp.end();

                if (typeof cb == "function") {
                    cb(null, res);
                } else {
                    return Promise.resolve(res);
                }
            })
            .catch((err) => {
                if (this.ftp && this.getConnectionStatus() != "disconnected")
                    this.ftp.end();
                if (typeof cb == "function") {
                    cb(err, null);
                } else {
                    return Promise.reject(err);
                }
            });
    }

}
util.inherits(FtpDeployer, events.EventEmitter);


const ftpDeploy = new FtpDeployer();
console.log(chalk.green("Rocket deploy 📦"));

ftpDeploy
    .deploy(config)
    .then(res => console.log(chalk.green("Finished 🚀")))
    .catch(err => console.log(chalk.red(err.message)));

ftpDeploy.on("uploaded", function (data) {
    process.stdout.write(chalk.yellow(`${data.transferredFileCount}/${data.totalFilesCount}\r`));
});

ftpDeploy.on("upload-error", function (data) {
    console.log(chalk.red(data.err));
});
