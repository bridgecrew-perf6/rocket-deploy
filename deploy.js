//https://www.npmjs.com/package/ftp-deploy

const FtpDeploy = require("ftp-deploy");
const ftpDeploy = new FtpDeploy();

const config = {
    user: "",
    // Password optional, prompted if none given
    password: "",
    host: "",
    port: 21,
    localRoot: __dirname + "/",
    remoteRoot: "",
    // include: ["*", "**/*"],      // this would upload everything except dot files
    include: ["{,.}*"],
    // e.g. exclude sourcemaps, and ALL files in node_modules (including dot files)
    exclude: [
        "dist/**/*.map",
        "node_modules",
        "node_modules/**",
        "node_modules/**/.*",
        ".git/**",
        "deploy.js",
        "package.json",
        "package-lock.json",
        "README.md",
        "composer.lock",
        ".gitignore",
        ".github",
        ".DS_Store"
    ],
    // delete ALL existing files at destination before uploading, if true
    deleteRemote: false,
    // Passive mode is forced (EPSV command is not sent)
    forcePasv: true,
    // use sftp or ftp
    sftp: false
};

const writeEveryCountedFile = 5;
// higher number => better performance
// write every "n" transferred file count of total

console.log("Rocket deploy 📦");

ftpDeploy
    .deploy(config)
    .then(res => console.log("Finished 🚀"))
    .catch(err => console.log(err));

ftpDeploy.on("uploaded", function (data) {
    if (data.transferredFileCount % writeEveryCountedFile) return;
    process.stdout.write(`${data.transferredFileCount}/${data.totalFilesCount}\r`);
});
