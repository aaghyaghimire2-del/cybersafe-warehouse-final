-- Warehouse Cyber Watch — MySQL schema
-- ---------------------------------------------------------------
-- Run this once before starting the server, using either:
--   1) phpMyAdmin (XAMPP control panel → Admin next to MySQL) →
--      "Import" tab → choose this file → Go
--   2) Command line:
--        mysql -u root -p < schema.sql
--      (XAMPP's default root password is blank, so just press Enter)
-- ---------------------------------------------------------------

CREATE DATABASE IF NOT EXISTS cyberwatch_final
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE cyberwatch_final;


-- Accounts. username_key is the lowercased, unique login key;
-- display_name preserves the casing the person typed at registration.
CREATE TABLE IF NOT EXISTS users (
  username_key   VARCHAR(24) PRIMARY KEY,
  display_name   VARCHAR(24) NOT NULL,
  salt           VARCHAR(64) NOT NULL,
  password_hash  VARCHAR(256) NOT NULL,
  created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- One row per completed/ended shift.
CREATE TABLE IF NOT EXISTS scores (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  username_key      VARCHAR(24) NOT NULL,
  score             INT NOT NULL,
  found             INT NOT NULL,
  total             INT NOT NULL,
  difficulty        VARCHAR(10) NOT NULL,
  all_found         TINYINT(1) NOT NULL DEFAULT 0,
  wrong_count       INT NOT NULL DEFAULT 0,
  decoys_correct    INT NOT NULL DEFAULT 0,
  decoys_total      INT NOT NULL DEFAULT 0,
  time_left_at_end  FLOAT NOT NULL DEFAULT 0,
  time_limit        FLOAT NOT NULL DEFAULT 1,
  created_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_scores_user FOREIGN KEY (username_key)
    REFERENCES users(username_key) ON DELETE CASCADE,
  INDEX idx_scores_username (username_key)
) ENGINE=InnoDB;

-- One row per account: XP, rank progress, unlocked/completed levels,
-- best score per level, and earned achievement ids (stored as a JSON
-- array string — kept as TEXT rather than the MySQL JSON type for
-- compatibility with older MariaDB versions some XAMPP builds ship).
CREATE TABLE IF NOT EXISTS progress (
  username_key      VARCHAR(24) PRIMARY KEY,
  xp                INT NOT NULL DEFAULT 0,
  unlocked_easy     TINYINT(1) NOT NULL DEFAULT 1,
  unlocked_normal   TINYINT(1) NOT NULL DEFAULT 0,
  unlocked_hard     TINYINT(1) NOT NULL DEFAULT 0,
  completed_easy    TINYINT(1) NOT NULL DEFAULT 0,
  completed_normal  TINYINT(1) NOT NULL DEFAULT 0,
  completed_hard    TINYINT(1) NOT NULL DEFAULT 0,
  best_easy         INT NOT NULL DEFAULT 0,
  best_normal       INT NOT NULL DEFAULT 0,
  best_hard         INT NOT NULL DEFAULT 0,
  achievements      TEXT NOT NULL,
  CONSTRAINT fk_progress_user FOREIGN KEY (username_key)
    REFERENCES users(username_key) ON DELETE CASCADE
) ENGINE=InnoDB;
