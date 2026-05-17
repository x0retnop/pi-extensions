const fixDrive = (p) =>
  p
    .replace(/([A-Za-z]):\\([a-z])\\/g, (m, drive, letter) =>
      drive.toLowerCase() === letter ? '/' + letter + '/' : m
    )
    .replace(/^([A-Za-z]):[/\\]/, (m, drive) => '/' + drive.toLowerCase() + '/');

console.log('C:\\10x001\\pi ->', fixDrive('C:\\10x001\\pi'));
console.log('C:/10x001/pi   ->', fixDrive('C:/10x001/pi'));
console.log('C:\\c\\test     ->', fixDrive('C:\\c\\test'));
console.log('C:/c/test      ->', fixDrive('C:/c/test'));
