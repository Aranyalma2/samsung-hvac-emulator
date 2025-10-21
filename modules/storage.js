const fs = require('fs').promises;
const path = require('path');

const DATA_FILE = path.join(__dirname, '..', 'data', 'slaves.json');
const CONFIG_FILE = path.join(__dirname, '..', 'config', 'config.json');

class Storage {
  constructor() {
    this.slaves = {};
    this.config = {};
  }

  async initialize(slaveIds, registerCount) {
    // Ensure data directory exists
    const dataDir = path.dirname(DATA_FILE);
    try {
      await fs.mkdir(dataDir, { recursive: true });
    } catch (err) {
      console.error('Error creating data directory:', err);
    }

    // Initialize slaves structure
    slaveIds.forEach(slaveId => {
      this.slaves[slaveId] = {
        registers: new Array(registerCount).fill(0)
      };
    });

    // Load saved data
    await this.loadSlaves();
    await this.loadConfig();
  }

  async loadSlaves() {
    try {
      const data = await fs.readFile(DATA_FILE, 'utf8');
      const savedSlaves = JSON.parse(data);
      
      // Merge saved data with current structure
      Object.keys(savedSlaves).forEach(slaveId => {
        if (this.slaves[slaveId]) {
          this.slaves[slaveId].registers = savedSlaves[slaveId].registers;
        }
      });
      console.log('Loaded slave data from file');
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error('Error loading slave data:', err);
      }
    }
  }

  async saveSlaves() {
    try {
      await fs.writeFile(DATA_FILE, JSON.stringify(this.slaves, null, 2));
      console.log('Saved slave data to file');
    } catch (err) {
      console.error('Error saving slave data:', err);
    }
  }

  async loadConfig() {
    try {
      const data = await fs.readFile(CONFIG_FILE, 'utf8');
      this.config = JSON.parse(data);
      console.log('Loaded configuration from file');
    } catch (err) {
      if (err.code === 'ENOENT') {
        // Set default config
        this.config = {
          modbusTcp: {
            enabled: true,
            port: 8502
          },
          modbusRtu: {
            enabled: false,
            port: 'COM1',
            baudRate: 9600,
            dataBits: 8,
            parity: 'none',
            stopBits: 1
          }
        };
        await this.saveConfig();
      } else {
        console.error('Error loading config:', err);
      }
    }
  }

  async saveConfig() {
    try {
      const configDir = path.dirname(CONFIG_FILE);
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(CONFIG_FILE, JSON.stringify(this.config, null, 2));
      console.log('Saved configuration to file');
    } catch (err) {
      console.error('Error saving config:', err);
    }
  }

  async clearSlave(slaveId) {
    if (this.slaves[slaveId]) {
      this.slaves[slaveId].registers.fill(0);
      await this.saveSlaves();
    }
  }

  async clearAllSlaves() {
    Object.keys(this.slaves).forEach(slaveId => {
      this.slaves[slaveId].registers.fill(0);
    });
    await this.saveSlaves();
  }

  getSlaves() {
    return this.slaves;
  }

  getConfig() {
    return this.config;
  }

  async updateConfig(newConfig) {
    this.config = { ...this.config, ...newConfig };
    await this.saveConfig();
  }
}

module.exports = new Storage();