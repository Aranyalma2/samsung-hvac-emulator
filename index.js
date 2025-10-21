const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');

const storage = require('./modules/storage');
const ModbusTCP = require('./modules/modbus-tcp');
const ModbusRTU = require('./modules/modbus-rtu');

const SLAVE_IDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const REGISTER_COUNT = 500;

// Initialize modules
const modbusTcp = new ModbusTCP(storage);
const modbusRtu = new ModbusRTU(storage);

async function startServer() {
  // Initialize storage
  await storage.initialize(SLAVE_IDS, REGISTER_COUNT);
  const config = storage.getConfig();

  // Start Modbus servers based on config
  if (config.modbusTcp.enabled) {
    modbusTcp.start(config.modbusTcp.port);
  }

  if (config.modbusRtu.enabled) {
    modbusRtu.start(config.modbusRtu);
  }

  // Setup Express web server
  const app = express();
  app.use(bodyParser.urlencoded({ extended: false }));
  app.use(express.static(path.join(__dirname, 'public')));
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));

  // Setup routes
  const indexRoute = require('./routes/index')(SLAVE_IDS);
  const slaveRoute = require('./routes/slave')(storage, SLAVE_IDS);
  const configRoute = require('./routes/config')(storage, modbusTcp, modbusRtu, SLAVE_IDS);

  app.use('/', indexRoute);
  app.use('/', slaveRoute);
  app.use('/', configRoute);

  const WEB_PORT = 3000;
  app.listen(WEB_PORT, () => {
    console.log(`Web server is listening on port ${WEB_PORT}`);
    console.log(`Access the interface at http://localhost:${WEB_PORT}`);
  });
}

startServer().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});