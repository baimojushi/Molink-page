'use strict';

const db = require('../../database');
const config = require('./config');
const { SqliteEtaRepository } = require('./repository/sqliteRepository');
const { EtaApplicationService } = require('./applicationService');

const repository = new SqliteEtaRepository(db);
const service = new EtaApplicationService(repository, config);

module.exports = service;
module.exports.config = config;
module.exports.repository = repository;
module.exports.EtaApplicationService = EtaApplicationService;
