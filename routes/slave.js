const express = require('express');
const router = express.Router();

module.exports = (storage, slaveIds) => {
  router.get('/slave/:id', (req, res) => {
    const slaveId = parseInt(req.params.id, 10);
    const slaves = storage.getSlaves();
    
    if (!slaves[slaveId]) {
      return res.status(404).send("Eszköz nem található");
    }

    let group = parseInt(req.query.group, 10);
    if (isNaN(group) || group < 1 || group > 7) {
      group = 1;
    }

    let registers = [];
    let startReg = 0;
    
    if (group === 1) {
      // First group: only 6 registers
      registers = slaves[slaveId].registers.slice(0, 6);
      startReg = 0;
    } else {
      // Groups 2-7: 50 registers each
      const start = (group - 1) * 50;
      registers = slaves[slaveId].registers.slice(start, start + 50);
      startReg = start;
    }

    res.render('slave', { 
      slaves: slaveIds, 
      slaveId, 
      registers, 
      group,
      startReg
    });
  });

  router.post('/slave/:id', async (req, res) => {
    const slaveId = parseInt(req.params.id, 10);
    const slaves = storage.getSlaves();
    
    if (!slaves[slaveId]) {
      return res.status(404).send("Eszköz nem található");
    }

    let group = parseInt(req.query.group, 10);
    if (isNaN(group) || group < 1 || group > 7) {
      group = 1;
    }

    try {
      if (group === 1) {
        // Update first 6 registers
        for (let i = 0; i < 6; i++) {
          const regKey = `reg${i}`;
          if (req.body[regKey] !== undefined) {
            const value = parseInt(req.body[regKey], 10);
            if (!isNaN(value)) {
              slaves[slaveId].registers[i] = value & 0xFFFF;
            }
          }
        }
      } else {
        // Update 50 registers for groups 2-7
        const base = (group - 1) * 50;
        for (let i = 0; i < 50; i++) {
          const regKey = `reg${i}`;
          if (req.body[regKey] !== undefined) {
            const value = parseInt(req.body[regKey], 10);
            if (!isNaN(value)) {
              slaves[slaveId].registers[base + i] = value & 0xFFFF;
            }
          }
        }
      }
      
      await storage.saveSlaves();
      res.redirect(`/slave/${slaveId}?group=${group}`);
    } catch (err) {
      console.error('Error saving slave data:', err);
      res.status(500).send('Hiba történt a mentés során');
    }
  });

  router.post('/slave/:id/clear', async (req, res) => {
    const slaveId = parseInt(req.params.id, 10);
    const group = parseInt(req.query.group, 10) || 1;
    
    try {
      await storage.clearSlave(slaveId);
      res.redirect(`/slave/${slaveId}?group=${group}`);
    } catch (err) {
      console.error('Error clearing slave:', err);
      res.status(500).send('Hiba történt a törlés során');
    }
  });

  return router;
};