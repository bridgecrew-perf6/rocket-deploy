# Rocket deploy 🚀

## Installation
```
npm i rckt-deploy
```

## Add to root directory of your project file `.rckt-deploy.json`
Example of this file:
```
{
    "user": "fpt-user",
    "password": "", //no password will prompt for password on every deploy
    "host": "ftp.host.com",
    "port": 21,
    "remoteRoot": "www/web/"
}
```

## To run the deployment
```
npm run deploy
```

### Can be used with any programming language and any ftp/ftps.

### Add exclude file don't remove it on deploy, you have to allow delete whole folder.

Original source: https://github.com/simonh1000/ftp-deploy
