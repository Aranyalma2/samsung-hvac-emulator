const express = require("express");
const router = express.Router();

module.exports = (storage, modbusTcp, modbusRtu, slaveIds) => {
	router.get("/config", (req, res) => {
		const config = storage.getConfig();
		res.render("config", {
			slaves: slaveIds,
			config,
			message: req.query.message,
		});
	});

	router.post("/config", async (req, res) => {
		const config = storage.getConfig();

		// Update Modbus TCP config
		const tcpEnabled = req.body.modbusTcpEnabled === "on";
		const tcpPort = parseInt(req.body.modbusTcpPort, 10) || 8502;

		config.modbusTcp.enabled = tcpEnabled;
		config.modbusTcp.port = tcpPort;

		// Update Modbus RTU config
		const rtuEnabled = req.body.modbusRtuEnabled === "on";
		config.modbusRtu.enabled = rtuEnabled;
		config.modbusRtu.port = req.body.modbusRtuPort || "COM1";
		config.modbusRtu.baudRate = parseInt(req.body.modbusRtuBaudRate, 10) || 9600;
		config.modbusRtu.dataBits = parseInt(req.body.modbusRtuDataBits, 10) || 8;
		config.modbusRtu.parity = req.body.modbusRtuParity || "none";
		config.modbusRtu.stopBits = parseInt(req.body.modbusRtuStopBits, 10) || 1;

		await storage.updateConfig(config);

		// Apply changes
		if (tcpEnabled) {
			modbusTcp.restart(tcpPort);
		} else {
			modbusTcp.stop();
		}

		if (rtuEnabled) {
			modbusRtu.restart(config.modbusRtu);
		} else {
			modbusRtu.stop();
		}

		res.redirect("/config?message=Configuration saved successfully");
	});

	router.post("/config/clear-all", async (req, res) => {
		await storage.clearAllSlaves();
		res.redirect("/config?message=All slaves cleared successfully");
	});

	return router;
};
