const input = 'echo "C:\\c\\10x001\\pi"';
console.log('input:', JSON.stringify(input));

const fixDrive = (p) =>
  p
    .replace(/([A-Za-z]):\\([a-z])\\/g, (m, drive, letter) =>
      drive.toLowerCase() === letter ? '/' + letter + '/' : m
    )
    .replace(/^([A-Za-z]):\//, (m, drive) => '/' + drive.toLowerCase() + '/');

let cmd = input;
cmd = cmd.replace(/"([A-Za-z]:\\(?:[^"]|\\.)*)"/g, (match, inner) => {
  console.log('inner:', JSON.stringify(inner));
  let p = inner
    .replace(/\\"/g, '"')
    .replace(/\\/g, '/')
    .replace(/\/$/, '');
  console.log('after backslash replace:', JSON.stringify(p));
  p = fixDrive(p);
  console.log('after fixDrive:', JSON.stringify(p));
  if (p.includes(' ')) return "'" + p + "'";
  return p;
});
console.log('output:', JSON.stringify(cmd));
