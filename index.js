/**
 * Modbus RTU Multi-Slave Server with Web Interface
 *
 * This project does two things:
 * 1. Listens on a TCP port for Modbus RTU packets. It emulates multiple Modbus RTU slaves 
 *    (each defined by a unique slaveId) that maintain an in-memory array of 500 holding registers.
 *    Only function codes for reading/writing holding registers (0x03, 0x06, 0x10) are supported.
 *    If a register address >= 500 is requested, zero is returned.
 *
 * 2. Hosts a web server that shows a sidebar with the defined slaves. For each slave, clicking a link 
 *    displays a page with multiple register groups. Group 1 displays the first 6 registers, and
 *    groups 2 to 7 display 50 registers each (starting at register 50 for group 2, register 100 for group 3, etc.).
 *    All registers are presented as editable fields. Clicking the submit button will update the 
 *    corresponding in-memory register values.
 */

const net = require('net');
const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');

// ----- Modbus RTU Configuration -----
// List of slave IDs to emulate. For each slave, we store 500 holding registers (addresses 0 to 499).
const SLAVE_IDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]; // Adjust or add slave IDs as necessary.
const REGISTER_COUNT = 500;

// Map of slave id to register array.
const slaves = {};
SLAVE_IDS.forEach(slaveId => {
  slaves[slaveId] = {
    registers: new Array(REGISTER_COUNT).fill(0)
  };
});

// ----- Modbus RTU CRC Calculation -----
function calculateCRC(buffer) {
  let crc = 0xFFFF;
  for (let pos = 0; pos < buffer.length; pos++) {
    crc ^= buffer[pos];
    for (let i = 0; i < 8; i++) {
      if ((crc & 0x0001) !== 0) {
        crc = (crc >> 1) ^ 0xA001;
      } else {
        crc = crc >> 1;
      }
    }
  }
  return crc;
}

function appendCRC(bufferWithoutCRC) {
  const crc = calculateCRC(bufferWithoutCRC);
  const crcBuf = Buffer.alloc(2);
  // Modbus sends CRC as low byte first.
  crcBuf.writeUInt8(crc & 0xFF, 0);
  crcBuf.writeUInt8((crc >> 8) & 0xFF, 1);
  return Buffer.concat([bufferWithoutCRC, crcBuf]);
}

function verifyCRC(buffer) {
  if (buffer.length < 3) return false;
  const data = buffer.slice(0, -2);
  const receivedCrc = buffer.readUInt16LE(buffer.length - 2);
  const calculatedCrc = calculateCRC(data);
  return receivedCrc === calculatedCrc;
}

// ----- Helper: Create Exception Response -----
function createExceptionResponse(slaveId, functionCode, exceptionCode) {
  const exceptionFunctionCode = functionCode | 0x80;
  const responseWithoutCRC = Buffer.from([slaveId, exceptionFunctionCode, exceptionCode]);
  return appendCRC(responseWithoutCRC);
}

// ----- Process Modbus RTU Request -----
function processRequest(requestBuffer) {
  if (requestBuffer.length < 4) {
    console.error('Request too short.');
    return null;
  }
  // Verify the CRC
  if (!verifyCRC(requestBuffer)) {
    console.error('Invalid CRC');
    return null;
  }

  const slaveId = requestBuffer.readUInt8(0);
  const functionCode = requestBuffer.readUInt8(1);

  if (!(slaveId in slaves)) {
    console.error(`Slave ID ${slaveId} not configured.`);
    return null;
  }

  let responseWithoutCRC;
  switch (functionCode) {
    // Read Holding Registers (Function code 0x03)
    case 0x03: {
      if (requestBuffer.length !== 8) {
        console.error('Invalid length for Read Holding Registers');
        return null;
      }
      const startAddr = requestBuffer.readUInt16BE(2);
      const quantity = requestBuffer.readUInt16BE(4);
      const byteCount = quantity * 2;
      const responseBuffer = Buffer.alloc(3 + byteCount);
      responseBuffer.writeUInt8(slaveId, 0);
      responseBuffer.writeUInt8(functionCode, 1);
      responseBuffer.writeUInt8(byteCount, 2);

      for (let i = 0; i < quantity; i++) {
        let val = 0;
        if (startAddr + i < REGISTER_COUNT) {
          val = slaves[slaveId].registers[startAddr + i];
        }
        responseBuffer.writeUInt16BE(val, 3 + i * 2);
      }
      responseWithoutCRC = responseBuffer;
      break;
    }

    // Write Single Register (Function code 0x06)
    case 0x06: {
      if (requestBuffer.length !== 8) {
        console.error('Invalid length for Write Single Register');
        return null;
      }
      const regAddr = requestBuffer.readUInt16BE(2);
      const value = requestBuffer.readUInt16BE(4);
      if (regAddr < REGISTER_COUNT) {
        slaves[slaveId].registers[regAddr] = value;
      }
      // Echo back the request (without CRC)
      responseWithoutCRC = requestBuffer.slice(0, 6);
      break;
    }

    // Write Multiple Registers (Function code 0x10)
    case 0x10: {
      if (requestBuffer.length < 9) {
        console.error('Invalid length for Write Multiple Registers');
        return null;
      }
      const startAddr = requestBuffer.readUInt16BE(2);
      const quantity = requestBuffer.readUInt16BE(4);
      const byteCount = requestBuffer.readUInt8(6);

      if (byteCount !== quantity * 2 || requestBuffer.length !== (7 + byteCount + 2)) {
        console.error('Byte count mismatch in Write Multiple Registers');
        return null;
      }

      for (let i = 0; i < quantity; i++) {
        const value = requestBuffer.readUInt16BE(7 + i * 2);
        if (startAddr + i < REGISTER_COUNT) {
          slaves[slaveId].registers[startAddr + i] = value;
        }
      }
      responseWithoutCRC = Buffer.alloc(6);
      responseWithoutCRC.writeUInt8(slaveId, 0);
      responseWithoutCRC.writeUInt8(functionCode, 1);
      responseWithoutCRC.writeUInt16BE(startAddr, 2);
      responseWithoutCRC.writeUInt16BE(quantity, 4);
      break;
    }

    default:
      console.error(`Unsupported function code: ${functionCode}`);
      return createExceptionResponse(slaveId, functionCode, 0x01);
  }

  return appendCRC(responseWithoutCRC);
}

// ----- Start TCP Server (Modbus RTU over TCP) -----
const TCP_PORT = 8502; // Standard Modbus port would be 502, but use 8502 to avoid permission issues.
const modbusServer = net.createServer((socket) => {
  console.log('Modbus Client connected:', socket.remoteAddress, socket.remotePort);
  socket.on('data', (data) => {
    console.log('Received Modbus data:', data.toString('hex'));
    // Assume each received data chunk is exactly one Modbus RTU frame.
    const response = processRequest(data);
    if (response) {
      console.log('Sending Modbus response:', response.toString('hex'));
      socket.write(response);
    } else {
      console.error('No valid response generated for Modbus frame.');
    }
  });

  socket.on('end', () => {
    console.log('Modbus Client disconnected.');
  });

  socket.on('error', (err) => {
    console.error('Modbus Socket error:', err);
  });
});

modbusServer.listen(TCP_PORT, () => {
  console.log(`Modbus RTU Server is listening on port ${TCP_PORT}`);
});

// ----- Start Express Web Server (HTTP Interface) -----
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Home page: list all available slaves in the left sidebar.
app.get('/', (req, res) => {
  res.render('index', { slaves: SLAVE_IDS });
});

// Display page for a specific slave.
// Shows registers in groups. Group 1 shows the first 6 registers,
// while groups 2-7 display 50 registers each.
// The group to display is selected via a query parameter (?group=).
app.get('/slave/:id', (req, res) => {
  const slaveId = parseInt(req.params.id, 10);
  if (!slaves[slaveId]) {
    return res.status(404).send("Slave not found");
  }

  let group = parseInt(req.query.group, 10);
  if (isNaN(group) || group < 1 || group > 7) {
    group = 1;
  }

  let registers = [];
  if (group === 1) {
    // First group: registers 0 to 5 (first 6 registers)
    registers = slaves[slaveId].registers.slice(0, 6);
  } else {
    // Groups 2 to 7: each group shows 50 registers.
    // Group 2: registers 50-99, group 3: 100-149, etc.
    const start = (group - 1) * 50;
    registers = slaves[slaveId].registers.slice(start, start + 50);
  }

  res.render('slave', { slaves: SLAVE_IDS, slaveId, registers, group });
});

// Process form submission for updating registers.
app.post('/slave/:id', (req, res) => {
  const slaveId = parseInt(req.params.id, 10);
  if (!slaves[slaveId]) {
    return res.status(404).send("Slave not found");
  }

  let group = parseInt(req.query.group, 10);
  if (isNaN(group) || group < 1 || group > 7) {
    group = 1;
  }

  if (group === 1) {
    // Update registers 0 to 5.
    for (let i = 0; i < 6; i++) {
      const regKey = `reg${i}`;
      const value = parseInt(req.body[regKey], 10);
      if (!isNaN(value)) {
        slaves[slaveId].registers[i] = value;
      }
    }
  } else {
    // For groups 2-7, update 50 registers.
    const base = (group - 1) * 50;
    for (let i = 0; i < 50; i++) {
      const regKey = `reg${i}`;
      const value = parseInt(req.body[regKey], 10);
      if (!isNaN(value)) {
        slaves[slaveId].registers[base + i] = value;
      }
    }
  }
  res.redirect(`/slave/${slaveId}?group=${group}`);
});

const WEB_PORT = 2999;
app.listen(WEB_PORT, () => {
  console.log(`Web server is listening on port ${WEB_PORT}`);
});