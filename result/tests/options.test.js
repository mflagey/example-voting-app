const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const io = require('../views/socket.io.js');

const resultDir = path.resolve(__dirname, '..');

async function connectToServer(t, options) {
  const env = { ...process.env, PORT: '0', POSTGRES_HOST: '127.0.0.1' };
  delete env.OPTION_A;
  delete env.OPTION_B;
  delete env.POSTGRES_PASSWORD_FILE;
  Object.assign(env, options);

  const server = spawn(process.execPath, ['server.js'], { cwd: resultDir, env });
  t.after(() => server.kill());
  const port = await new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error('Server did not start')), 5000);
    server.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/App running on port (\d+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(match[1]);
      }
    });
    server.once('error', error => {
      clearTimeout(timeout);
      reject(error);
    });
    server.once('exit', code => {
      clearTimeout(timeout);
      reject(new Error(`Server exited before starting: ${code}`));
    });
  });

  const socket = io(`http://127.0.0.1:${port}`, {
    reconnection: false,
    transports: ['websocket']
  });
  t.after(() => socket.close());
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('No welcome message received')), 5000);
    socket.on('message', data => {
      clearTimeout(timeout);
      resolve(data);
    });
    socket.on('connect_error', error => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

test('server sends default, custom and empty option labels', async t => {
  for (const [options, expected] of [
    [{}, ['Cats', 'Dogs']],
    [{ OPTION_A: 'Thé & café', OPTION_B: '<Coffee>' }, ['Thé & café', '<Coffee>']],
    [{ OPTION_A: '', OPTION_B: '' }, ['', '']]
  ]) {
    const message = await connectToServer(t, options);
    assert.equal(message.optionA, expected[0]);
    assert.equal(message.optionB, expected[1]);
  }
});

test('client displays received labels and keeps updating scores', () => {
  const handlers = {};
  const backgrounds = [{ style: {} }, { style: {} }];
  const scope = { $apply: callback => callback() };
  const document = {
    body: { style: {} },
    getElementById: id => backgrounds[id === 'background-stats-1' ? 0 : 1]
  };
  const angular = {
    module: () => ({ controller: (name, controller) => controller(scope) })
  };
  const context = { angular, document, io: { connect: () => ({
    on: (event, handler) => { handlers[event] = handler; }
  }) } };
  vm.runInNewContext(fs.readFileSync(path.join(resultDir, 'views/app.js'), 'utf8'), context);

  handlers.message({ optionA: 'Thé & café', optionB: '<Coffee>' });
  assert.equal(scope.optionA, 'Thé & café');
  assert.equal(scope.optionB, '<Coffee>');
  handlers.scores(JSON.stringify({ a: 1, b: 3 }));
  assert.equal(scope.aPercent, 25);
  assert.equal(scope.bPercent, 75);
  assert.equal(scope.total, 4);
  assert.equal(backgrounds[0].style.width, '25%');
  assert.equal(backgrounds[1].style.width, '75%');

  const html = fs.readFileSync(path.join(resultDir, 'views/index.html'), 'utf8');
  assert.match(html, /<html ng-app="catsvsdogs" ng-controller="statsCtrl">/);
  assert.match(html, /<title>{{optionA}} vs {{optionB}} -- Result<\/title>/);
  assert.match(html, /<div class="label">{{optionA}}<\/div>/);
  assert.match(html, /<div class="label">{{optionB}}<\/div>/);
});
