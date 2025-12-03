const { SerialPort } = require("serialport");

class ModbusRTU {
	constructor(storage) {
		this.storage = storage;
		this.port = null;
		this.registerCount = 500;
		this.buffer = Buffer.alloc(0);
		this.frameTimeout = null;
	}

	calculateCRC(buffer) {
		let crc = 0xffff;
		for (let pos = 0; pos < buffer.length; pos++) {
			crc ^= buffer[pos];
			for (let i = 0; i < 8; i++) {
				if ((crc & 0x0001) !== 0) {
					crc = (crc >> 1) ^ 0xa001;
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
		crcBuf.writeUInt8(crc & 0xff, 0);
		crcBuf.writeUInt8((crc >> 8) & 0xff, 1);
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
				console.error("Request too short.");
				return null;
			}

			if (!this.verifyCRC(requestBuffer)) {
				console.error("Invalid CRC");
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
						console.error("Invalid length for Read Holding Registers");
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
						console.error("Invalid length for Write Single Register");
						return null;
					}
					const regAddr = requestBuffer.readUInt16BE(2);
					const value = requestBuffer.readUInt16BE(4);
					if (regAddr < this.registerCount) {
						slaves[slaveId].registers[regAddr] = value;
						this.storage.saveSlaves().catch((err) => console.error("Error saving slaves:", err));
					}
					responseWithoutCRC = requestBuffer.slice(0, 6);
					break;
				}

				case 0x10: {
					if (requestBuffer.length < 9) {
						console.error("Invalid length for Write Multiple Registers");
						return null;
					}
					const startAddr = requestBuffer.readUInt16BE(2);
					const quantity = requestBuffer.readUInt16BE(4);
					const byteCount = requestBuffer.readUInt8(6);

					if (byteCount !== quantity * 2 || requestBuffer.length !== 7 + byteCount + 2) {
						console.error("Byte count mismatch in Write Multiple Registers");
						return null;
					}

					for (let i = 0; i < quantity; i++) {
						const value = requestBuffer.readUInt16BE(7 + i * 2);
						if (startAddr + i < this.registerCount) {
							slaves[slaveId].registers[startAddr + i] = value;
						}
					}
					this.storage.saveSlaves().catch((err) => console.error("Error saving slaves:", err));

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
			console.error("Error processing Modbus RTU request:", err);
			return null;
		}
	}

	start(config) {
		if (this.port && this.port.isOpen) {
			console.log("Modbus RTU port already open");
			return;
		}

		try {
			this.port = new SerialPort({
				path: config.port,
				baudRate: config.baudRate,
				dataBits: config.dataBits,
				parity: config.parity,
				stopBits: config.stopBits,
				autoOpen: false,
			});

			this.port.open((err) => {
				if (err) {
					console.error(`Failed to open Modbus RTU Serial port ${config.port}:`, err.message);
					this.port = null;
					return;
				}
				console.log(`Modbus RTU Serial port ${config.port} opened successfully`);
			});

			this.port.on("data", (data) => {
				console.log("Received Modbus RTU data:", data.toString("hex"));

				// Clear previous timeout
				if (this.frameTimeout) {
					clearTimeout(this.frameTimeout);
				}

				// Accumulate data in buffer
				this.buffer = Buffer.concat([this.buffer, data]);

				// Set timeout to process frame after silence
				this.frameTimeout = setTimeout(() => {
					if (this.buffer.length >= 8) {
						const response = this.processRequest(this.buffer);
						if (response && this.port && this.port.isOpen) {
							console.log("Sending Modbus RTU response:", response.toString("hex"));
							this.port.write(response, (err) => {
								if (err) {
									console.error("Error writing to serial port:", err);
								}
							});
						}
					}
					this.buffer = Buffer.alloc(0);
				}, 50); // 50ms silence threshold
			});

			this.port.on("error", (err) => {
				console.error("Modbus RTU Serial port error:", err.message);
			});

			this.port.on("close", () => {
				console.log("Modbus RTU Serial port closed");
				this.port = null;
			});
		} catch (err) {
			console.error("Error creating Modbus RTU Serial port:", err.message);
			this.port = null;
		}
	}

	stop() {
		if (this.frameTimeout) {
			clearTimeout(this.frameTimeout);
			this.frameTimeout = null;
		}

		if (this.port && this.port.isOpen) {
			this.port.close((err) => {
				if (err) {
					console.error("Error closing Modbus RTU port:", err.message);
				} else {
					console.log("Modbus RTU port stopped");
				}
				this.port = null;
			});
		} else {
			this.port = null;
		}
	}

	restart(config) {
		this.stop();
		setTimeout(() => this.start(config), 1000);
	}
}

module.exports = ModbusRTU;
