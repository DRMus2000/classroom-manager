-- 记分批次补录备注。空字符串不入库，由服务层写成 NULL。
ALTER TABLE point_batch ADD COLUMN IF NOT EXISTS note text;
ALTER TABLE point_batch DROP CONSTRAINT IF EXISTS ck_batch_note_len;
ALTER TABLE point_batch ADD CONSTRAINT ck_batch_note_len CHECK (note IS NULL OR char_length(note) <= 500);
