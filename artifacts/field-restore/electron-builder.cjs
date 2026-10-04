const path = require('node:path');
module.exports = {
  appId: 'org.fieldrestore.desktop',
  productName: 'Field Restore',
  electronVersion: require('electron/package.json').version,
  directories: { output: path.join(__dirname, 'release') },
  files: ['main.cjs', 'preload.cjs', 'native-save.cjs', 'package.json', 'web/**/*'],
  asar: true,
  npmRebuild: false,
  win: { icon: path.join(__dirname, 'public/icons/app.ico'), signAndEditExecutable: false },
};