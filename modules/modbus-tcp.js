const net = require('net');

class ModbusTCP {
  constructor(storage) {
    this.storage = storage;
    this.server = null;
    this.registerCount = 500;
  }

  calculateCRC(buffer) {
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

  appendCRC(bufferWithoutCRC) {
    const crc = this.calculateCRC(bufferWithoutCRC);
    const crcBuf = Buffer.alloc(2);
    crcBuf.writeUInt8(crc & 0xFF, 0);
    crcBuf.writeUInt8((crc >> 8) & 0xFF, 1);
    return Buffer.concat([bufferWithoutCRC, crcBuf]);
  }

  verifyCRC(buffer) {
    if (buffer.length < 3) return false;
    const data = buffer.slice(0, -2);
    const receivedCrc = buffer.readUInt16LE(buffer.length - 2);
    const calculatedCrc = this.calculateCRC(data);
    return receivedCrc === calculatedCrc;
  }

  createExceptionResponse(slaveId, functionCode, exceptionCode) {
    const exceptionFunctionCode = functionCode | 0x80;
    const responseWithoutCRC = Buffer.from([slaveId, exceptionFunctionCode, exceptionCode]);
    return this.appendCRC(responseWithoutCRC);
  }

  processRequest(requestBuffer) {
    try {
      if (requestBuffer.length < 4) {
        console.error('Request too short.');
        return null;
      }

      if (!this.verifyCRC(requestBuffer)) {
        console.error('Invalid CRC');
        return null;
      }

      const slaveId = requestBuffer.readUInt8(0);
      const functionCode = requestBuffer.readUInt8(1);
      const slaves = this.storage.getSlaves();

      if (!(slaveId in slaves)) {
        console.error(`Slave ID ${slaveId} not configured.`);
        return null;
      }

      let responseWithoutCRC;
      switch (functionCode) {
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
            if (startAddr + i < this.registerCount) {
              val = slaves[slaveId].registers[startAddr + i];
            }
            responseBuffer.writeUInt16BE(val, 3 + i * 2);
          }
          responseWithoutCRC = responseBuffer;
          break;
        }

        case 0x06: {
          if (requestBuffer.length !== 8) {
            console.error('Invalid length for Write Single Register');
            return null;
          }
          const regAddr = requestBuffer.readUInt16BE(2);
          const value = requestBuffer.readUInt16BE(4);
          if (regAddr < this.registerCount) {
            slaves[slaveId].registers[regAddr] = value;
            this.storage.saveSlaves().catch(err => console.error('Error saving slaves:', err));
          }
          responseWithoutCRC = requestBuffer.slice(0, 6);
          break;
        }

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
            if (startAddr + i < this.registerCount) {
              slaves[slaveId].registers[startAddr + i] = value;
            }
          }
          this.storage.saveSlaves().catch(err => console.error('Error saving slaves:', err));

          responseWithoutCRC = Buffer.alloc(6);
          responseWithoutCRC.writeUInt8(slaveId, 0);
          responseWithoutCRC.writeUInt8(functionCode, 1);
          responseWithoutCRC.writeUInt16BE(startAddr, 2);
          responseWithoutCRC.writeUInt16BE(quantity, 4);
          break;
        }

        default:
          console.error(`Unsupported function code: ${functionCode}`);
          return this.createExceptionResponse(slaveId, functionCode, 0x01);
      }

      return this.appendCRC(responseWithoutCRC);
    } catch (err) {
      console.error('Error processing Modbus TCP request:', err);
      return null;
    }
  }

  start(port) {
    if (this.server) {
      console.log('Modbus TCP server already running');
      return;
    }

    try {
      this.server = net.createServer((socket) => {
        console.log('Modbus TCP Client connected:', socket.remoteAddress, socket.remotePort);
        
        socket.on('data', (data) => {
          try {
            console.log('Received Modbus TCP data:', data.toString('hex'));
            const response = this.processRequest(data);
            if (response) {
              console.log('Sending Modbus TCP response:', response.toString('hex'));
              socket.write(response);
            } else {
              console.error('No valid response generated for Modbus TCP frame.');
            }
          } catch (err) {
            console.error('Error handling Modbus TCP data:', err);
          }
        });

        socket.on('end', () => {
          console.log('Modbus TCP Client disconnected.');
        });

        socket.on('error', (err) => {
          console.error('Modbus TCP Socket error:', err.message);
        });
      });

      this.server.on('error', (err) => {
        console.error('Modbus TCP Server error:', err.message);
        if (err.code === 'EADDRINUSE') {
          console.error(`Port ${port} is already in use`);
        }
      });

      this.server.listen(port, () => {
        console.log(`Modbus TCP Server is listening on port ${port}`);
      });
    } catch (err) {
      console.error('Error starting Modbus TCP server:', err.message);
      this.server = null;
    }
  }

  stop() {
    if (this.server) {
      this.server.close(() => {
        console.log('Modbus TCP Server stopped');
      });
      this.server = null;
    }
  }

  restart(port) {
    this.stop();
    setTimeout(() => this.start(port), 1000);
  }
}

module.exports = ModbusTCP;