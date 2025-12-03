const express = require("express");
const router = express.Router();

module.exports = (slaveIds) => {
	router.get("/", (req, res) => {
		res.render("index", { slaves: slaveIds });
	});

	return router;
};
