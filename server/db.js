const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.resolve(__dirname, '../database.sqlite');
const db = new Database(dbPath);

// Ativar suporte a Foreign Keys
db.pragma('foreign_keys = ON');

// Criação das tabelas
db.exec(`
  CREATE TABLE IF NOT EXISTS rotas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL UNIQUE,
    descricao TEXT,
    criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS hospitais (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    zona TEXT NOT NULL,
    rota_id INTEGER,
    endereco TEXT,
    telefone TEXT,
    criado_em DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (rota_id) REFERENCES rotas(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS pacientes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    cpf TEXT,
    contato TEXT,
    consultor TEXT,
    hospital TEXT,
    hospital_id INTEGER,
    zona TEXT,
    rota TEXT,
    status TEXT DEFAULT 'Em Análise',
    dataPrevista TEXT,
    prontuarios TEXT,
    criado_em DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (hospital_id) REFERENCES hospitais(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS anexos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    paciente_id INTEGER NOT NULL,
    nome_original TEXT NOT NULL,
    caminho_arquivo TEXT NOT NULL,
    tamanho_bytes INTEGER,
    mime_type TEXT,
    criado_em DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (paciente_id) REFERENCES pacientes(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS rotinas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    data TEXT NOT NULL UNIQUE,
    dia_semana TEXT,
    consultor TEXT,
    rotina_programada TEXT,
    feedback TEXT,
    status TEXT DEFAULT 'Planejado',
    criado_em DATETIME DEFAULT CURRENT_TIMESTAMP,
    atualizado_em DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS observacoes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    paciente_id INTEGER NOT NULL,
    autor TEXT NOT NULL,
    texto TEXT NOT NULL,
    criado_em DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (paciente_id) REFERENCES pacientes(id) ON DELETE CASCADE
  );
`);

// Migração segura para colunas caso a tabela pacientes já existisse sem elas
try { db.exec("ALTER TABLE pacientes ADD COLUMN hospital_id INTEGER REFERENCES hospitais(id) ON DELETE SET NULL;"); } catch (_) {}
try { db.exec("ALTER TABLE pacientes ADD COLUMN zona TEXT;"); } catch (_) {}
try { db.exec("ALTER TABLE pacientes ADD COLUMN rota TEXT;"); } catch (_) {}

// Migração de observações existentes em pacientes para a tabela observacoes
try {
  const pacientesComProntuario = db.prepare(`
    SELECT p.id, p.consultor, p.prontuarios, p.criado_em
    FROM pacientes p
    WHERE p.prontuarios IS NOT NULL AND TRIM(p.prontuarios) != ''
      AND NOT EXISTS (SELECT 1 FROM observacoes o WHERE o.paciente_id = p.id)
  `).all();

  const insertObs = db.prepare(`
    INSERT INTO observacoes (paciente_id, autor, texto, criado_em)
    VALUES (?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))
  `);

  for (const p of pacientesComProntuario) {
    insertObs.run(p.id, p.consultor || 'Cadastro Inicial', p.prontuarios, p.criado_em);
  }
} catch (e) {
  console.error("Erro na migração de observações:", e.message);
}

// Seed inicial com rotas, hospitais e rotinas caso o banco esteja vazio
try {
  const countRotas = db.prepare('SELECT COUNT(*) as count FROM rotas').get().count;
  if (countRotas === 0) {
    const insertRota = db.prepare('INSERT INTO rotas (nome, descricao) VALUES (?, ?)');
    const r1 = insertRota.run('Rota 1 - Fortaleza Central', 'Atendimento na região central de Fortaleza').lastInsertRowid;
    const r2 = insertRota.run('Rota 2 - Messejana / Sul', 'Atendimento na região sul e Messejana').lastInsertRowid;
    const r3 = insertRota.run('Rota 3 - Região Metropolitana', 'Atendimento na grande metrópole (Maracanaú, Caucaia)').lastInsertRowid;
    const r4 = insertRota.run('Rota 4 - Sertão Central / Interior', 'Hospitais de referência no interior do estado').lastInsertRowid;

    const countHospitais = db.prepare('SELECT COUNT(*) as count FROM hospitais').get().count;
    if (countHospitais === 0) {
      const insertHospital = db.prepare('INSERT INTO hospitais (nome, zona, rota_id, endereco, telefone) VALUES (?, ?, ?, ?, ?)');
      insertHospital.run('Hospital Geral de Fortaleza (HGF)', 'Fortaleza', r1, 'R. Ávila Goulart, 900 - Papicu, Fortaleza - CE', '(85) 3101-3209');
      insertHospital.run('Hospital de Messejana', 'Fortaleza', r2, 'Av. Frei Cirilo, 3480 - Messejana, Fortaleza - CE', '(85) 3101-4065');
      insertHospital.run('Hospital Metropolitano', 'Metrópole (Metropolis)', r3, 'Av. Radialista João Ramos, Maracanaú - CE', '(85) 3521-5500');
      insertHospital.run('Hospital Regional do Sertão Central (HRSC)', 'Interior', r4, 'Rodovia CE-060, km 198 - Quixeramobim - CE', '(88) 3406-1300');
    }
  }

  const countRotinas = db.prepare('SELECT COUNT(*) as count FROM rotinas').get().count;
  if (countRotinas === 0) {
    const hoje = new Date().toISOString().split('T')[0];
    const insertRotina = db.prepare(`
      INSERT INTO rotinas (data, dia_semana, consultor, rotina_programada, feedback, status)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    insertRotina.run(
      hoje,
      'Quarta-feira',
      'Equipe Externa',
      `- 08:30: Saída para Rota 1 (Fortaleza Central)\n- 09:15: Visita ao Hospital Geral de Fortaleza (HGF) para recolhimento de prontuários\n- 11:30: Validação de pendências de laudos\n- 14:00: Alinhamento de documentação no Hospital de Messejana\n- 16:30: Fechamento diário e arquivamento de fichas`,
      `- Visita ao HGF concluída com sucesso: 3 prontuários liberados e digitalizados.\n- Hospital de Messejana confirmou recepção da documentação.\n- Ocorrência: Nenhum atraso reportado nas rotas.`,
      'Em Andamento'
    );
  }
} catch (e) {
  console.error("Erro no seed inicial:", e.message);
}

module.exports = db;
