const net = require("net");

class ModbusTCP {
	constructor(storage) {
		this.storage = storage;
		this.server = null;
		this.registerCount = 500;
	}

	createExceptionResponse(transactionId, protocolId, unitId, functionCode, exceptionCode) {
		const response = Buffer.alloc(9); // MBAP (7 bytes) + Unit ID + Function Code + Exception Code
		response.writeUInt16BE(transactionId, 0);
		response.writeUInt16BE(protocolId, 2);
		response.writeUInt16BE(3, 4);
		response.writeUInt8(unitId, 6);
		response.writeUInt8(functionCode | 0x80, 7);
		response.writeUInt8(exceptionCode, 8);
		return response;
	}

	processRequest(requestBuffer) {
		try {
			// Modbus TCP minimum frame: MBAP (7 bytes) + Function Code (1 byte) = 8 bytes
			if (requestBuffer.length < 8) {
				console.error("Modbus TCP request too short.");
				return null;
			}

			// Parse MBAP Header
			const transactionId = requestBuffer.readUInt16BE(0);
			const protocolId = requestBuffer.readUInt16BE(2);
			const length = requestBuffer.readUInt16BE(4);
			const unitId = requestBuffer.readUInt8(6);
			const functionCode = requestBuffer.readUInt8(7);

			// Validate protocol ID (should be 0 for Modbus)
			if (protocolId !== 0) {
				console.error(`Invalid protocol ID: ${protocolId}`);
				return null;
			}

			// Validate length
			if (requestBuffer.length < 6 + length) {
				console.error("Incomplete Modbus TCP frame");
				return null;
			}

			const slaves = this.storage.getSlaves();

			if (!(unitId in slaves)) {
				console.error(`Unit ID ${unitId} not configured.`);
				return this.createExceptionResponse(transactionId, protocolId, unitId, functionCode, 0x0b);
			}

			// Extract PDU (Protocol Data Unit) - everything after Unit ID
			const pdu = requestBuffer.slice(7);

			let responsePDU;
			switch (functionCode) {
				case 0x03: {
					// Read Holding Registers
					if (pdu.length < 5) {
						console.error("Invalid length for Read Holding Registers");
						return this.createExceptionResponse(transactionId, protocolId, unitId, functionCode, 0x03);
					}
					const startAddr = pdu.readUInt16BE(1);
					const quantity = pdu.readUInt16BE(3);

					if (quantity < 1 || quantity > 125) {
						console.error("Invalid quantity for Read Holding Registers");
						return this.createExceptionResponse(transactionId, protocolId, unitId, functionCode, 0x03);
					}

					const byteCount = quantity * 2;
					responsePDU = Buffer.alloc(2 + byteCount);
					responsePDU.writeUInt8(functionCode, 0);
					responsePDU.writeUInt8(byteCount, 1);

					for (let i = 0; i < quantity; i++) {
						let val = 0;
						if (startAddr + i < this.registerCount) {
							val = slaves[unitId].registers[startAddr + i];
						}
						responsePDU.writeUInt16BE(val, 2 + i * 2);
					}
					break;
				}

				case 0x06: {
					// Write Single Register
					if (pdu.length < 5) {
						console.error("Invalid length for Write Single Register");
						return this.createExceptionResponse(transactionId, protocolId, unitId, functionCode, 0x03);
					}
					const regAddr = pdu.readUInt16BE(1);
					const value = pdu.readUInt16BE(3);

					if (regAddr < this.registerCount) {
						slaves[unitId].registers[regAddr] = value;
						this.storage.saveSlaves().catch((err) => console.error("Error saving slaves:", err));
					} else {
						return this.createExceptionResponse(transactionId, protocolId, unitId, functionCode, 0x02);
					}

					// Echo back the request PDU
					responsePDU = pdu.slice(0, 5);
					break;
				}

				case 0x10: {
					// Write Multiple Registers
					if (pdu.length < 6) {
						console.error("Invalid length for Write Multiple Registers");
						return this.createExceptionResponse(transactionId, protocolId, unitId, functionCode, 0x03);
					}
					const startAddr = pdu.readUInt16BE(1);
					const quantity = pdu.readUInt16BE(3);
					const byteCount = pdu.readUInt8(5);

					if (byteCount !== quantity * 2 || pdu.length < 6 + byteCount) {
						console.error("Byte count mismatch in Write Multiple Registers");
						return this.createExceptionResponse(transactionId, protocolId, unitId, functionCode, 0x03);
					}

					for (let i = 0; i < quantity; i++) {
						const value = pdu.readUInt16BE(6 + i * 2);
						if (startAddr + i < this.registerCount) {
							slaves[unitId].registers[startAddr + i] = value;
						}
					}
					this.storage.saveSlaves().catch((err) => console.error("Error saving slaves:", err));

					// Response: Function Code + Start Address + Quantity
					responsePDU = Buffer.alloc(5);
					responsePDU.writeUInt8(functionCode, 0);
					responsePDU.writeUInt16BE(startAddr, 1);
					responsePDU.writeUInt16BE(quantity, 3);
					break;
				}

				default:
					console.error(`Unsupported function code: ${functionCode}`);
					return this.createExceptionResponse(transactionId, protocolId, unitId, functionCode, 0x01);
			}

			const responseLength = responsePDU.length + 1;
			const response = Buffer.alloc(6 + responseLength);
			response.writeUInt16BE(transactionId, 0);
			response.writeUInt16BE(protocolId, 2);
			response.writeUInt16BE(responseLength, 4);
			response.writeUInt8(unitId, 6);
			responsePDU.copy(response, 7);

			return response;
		} catch (err) {
			console.error("Error processing Modbus TCP request:", err);
			return null;
		}
	}

	start(port) {
		if (this.server) {
			console.log("Modbus TCP server already running");
			return;
		}

		try {
			this.server = net.createServer((socket) => {
				console.log("Modbus TCP Client connected:", socket.remoteAddress, socket.remotePort);

				socket.on("data", (data) => {
					try {
						console.log("Received Modbus TCP data:", data.toString("hex"));
						const response = this.processRequest(data);
						if (response) {
							console.log("Sending Modbus TCP response:", response.toString("hex"));
							socket.write(response);
						} else {
							console.error("No valid response generated for Modbus TCP frame.");
						}
					} catch (err) {
						console.error("Error handling Modbus TCP data:", err);
					}
				});

				socket.on("end", () => {
					console.log("Modbus TCP Client disconnected.");
				});

				socket.on("error", (err) => {
					console.error("Modbus TCP Socket error:", err.message);
				});
			});

			this.server.on("error", (err) => {
				console.error("Modbus TCP Server error:", err.message);
				if (err.code === "EADDRINUSE") {
					console.error(`Port ${port} is already in use`);
				}
			});

			this.server.listen(port, () => {
				console.log(`Modbus TCP Server is listening on port ${port}`);
			});
		} catch (err) {
			console.error("Error starting Modbus TCP server:", err.message);
			this.server = null;
		}
	}

	stop() {
		if (this.server) {
			this.server.close(() => {
				console.log("Modbus TCP Server stopped");
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
