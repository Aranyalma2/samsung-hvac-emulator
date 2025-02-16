const net = require('net');

// Configuration for the TCP server and fixed device address
const HOST = '127.0.0.1'; // Change to your TCP server's IP if needed
const PORT = 8502;         // Common port for Modbus TCP (or your desired TCP port)
const DEVICE_ADDRESS = 0x01; // Fixed device address

// Global variable to keep track of the last read operation details
let pendingRead = null;

/**
 * Calculate CRC16 for Modbus.
 * This function computes the CRC for a given buffer.
 *
 * @param {Buffer} buffer - The buffer of data to calculate the CRC on.
 * @returns {number} - The computed CRC as a 16-bit number.
 */
function calculateCRC(buffer) {
  let crc = 0xFFFF;
  for (let pos = 0; pos < buffer.length; pos++) {
    crc ^= buffer[pos];
    for (let i = 0; i < 8; i++) {
      if (crc & 0x0001) {
        crc = (crc >> 1) ^ 0xA001;
      } else {
        crc = crc >> 1;
      }
    }
  }
  return crc;
}

// Create TCP client and connect to the server
const client = new net.Socket();
client.connect(PORT, HOST, () => {
  console.log('Connected to TCP Server');
});

// Listen to data coming from the TCP server
client.on('data', (data) => {
  // The data length must be at least 5 bytes (slave addr, function, byte count, and CRC)
  if (data.length < 5) {
    console.log('Received incomplete response:', data.toString('hex'));
    return;
  }
  
  const device = data[0];
  const functionCode = data[1];

  // Parse response for Read Holding Registers (Function 0x03)
  if (functionCode === 0x03) {
    const byteCount = data[2];
    // Ensure that the response has expected number of bytes: 3 (header) + byteCount + 2 (CRC)
    if (data.length < 3 + byteCount + 2) {
      console.error("Incomplete read response.");
      return;
    }

    if (pendingRead) {
      // Iterate over registers in the response
      for (let i = 0; i < pendingRead.quantity; i++) {
        const offset = 3 + (i * 2);
        // Get the register value in decimal (big-endian)
        const value = data.readUInt16BE(offset);
        // Calculate the register address based on the starting address given by the read request
        const registerAddress = pendingRead.start + i;
        console.log("Register " + registerAddress + ": " + value);
      }
      // Clear pending read data after processing
      pendingRead = null;
    } else {
      // Without pending read info, assume registers starting at 0
      const registers = byteCount / 2;
      for (let i = 0; i < registers; i++) {
        const offset = 3 + (i * 2);
        const value = data.readUInt16BE(offset);
        console.log("Register " + i + ": " + value);
      }
    }
  }
  // Parse response for Write Single Register (Function 0x06)
  else if (functionCode === 0x06) {
    // Check if the response has the expected length of 8 bytes (1+1+2+2+2)
    if (data.length < 8) {
      console.error("Incomplete write response.");
      return;
    }
    // Bytes 2-3: Register address
    const regAddr = data.readUInt16BE(2);
    // Bytes 4-5: Written value
    const value = data.readUInt16BE(4);
    console.log("Register " + regAddr + ": " + value);
  } else {
    console.log("Unknown or unhandled function code " + functionCode + " in response: " + data.toString('hex'));
  }
});

// Handle connection errors
client.on('error', (err) => {
  console.error("Socket error:", err);
});

/**
 * Sends a Modbus RTU request to read holding registers.
 *
 * @param {number} startAddress - The starting register address.
 * @param {number} quantity - The number of registers to read.
 */
function readHoldingRegisters(startAddress, quantity) {
  // Save the details of the pending read so we can print proper register addresses on response
  pendingRead = { start: startAddress, quantity };

  const requestLength = 8; // [addr] [func] [start addr (2)] [quantity (2)] [CRC (2)]
  let request = Buffer.alloc(requestLength);
  
  request[0] = DEVICE_ADDRESS;
  request[1] = 0x03; // Function code for "read holding registers"
  request.writeUInt16BE(startAddress, 2);
  request.writeUInt16BE(quantity, 4);
  
  // Calculate CRC for the first 6 bytes
  const crc = calculateCRC(request.slice(0, 6));
  request[6] = crc & 0xFF;             // CRC low byte
  request[7] = (crc >> 8) & 0xFF;        // CRC high byte

  console.log("Sending read request to registers " + startAddress + " through " + (startAddress + quantity - 1));
  client.write(request);
}

/**
 * Sends a Modbus RTU request to write a single holding register.
 *
 * @param {number} registerAddress - The register address to write to.
 * @param {number} value - The value to write.
 */
function writeHoldingRegister(registerAddress, value) {
  const requestLength = 8; // [addr] [func] [reg addr (2)] [value (2)] [CRC (2)]
  let request = Buffer.alloc(requestLength);
  
  request[0] = DEVICE_ADDRESS;
  request[1] = 0x06; // Function code for "write single register"
  request.writeUInt16BE(registerAddress, 2);
  request.writeUInt16BE(value, 4);
  
  // Calculate CRC for the first 6 bytes
  const crc = calculateCRC(request.slice(0, 6));
  request[6] = crc & 0xFF;             // CRC low byte
  request[7] = (crc >> 8) & 0xFF;        // CRC high byte

  console.log("Sending write request for register " + registerAddress + " with value " + value);
  client.write(request);
}

// Export functions in case you'd like to use them in another module
module.exports = { readHoldingRegisters, writeHoldingRegister };

// Example usage:
// After a short delay to allow the connection to establish, send a read request for 2 registers starting at address 0.
// Then, send a write request to write the value 1234 to register at address 10.
setTimeout(() => {
  readHoldingRegisters(329, 3);
}, 3000);

setTimeout(() => {
  writeHoldingRegister(0, 1234);
}, 1000);