const re = /^([A-Za-z]):[/\\](?!\1\/)/i;
console.log('C:/c/test  matches?', re.test('C:/c/test'));
console.log('C:/d/test  matches?', re.test('C:/d/test'));
console.log('C:\\foo   matches?', re.test('C:\\foo'));
