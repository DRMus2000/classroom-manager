import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';

const PORT = 55499;
const USER = 'classroom';
const PASSWORD = 'classroom_password';
const DATABASE = 'classroom_manager';
const dir = path.resolve('.demo/pg');
const fresh = !existsSync(dir);

const postgres = new EmbeddedPostgres({
  databaseDir: dir,
  user: USER,
  password: PASSWORD,
  port: PORT,
  persistent: true,
  initdbFlags: ['--encoding=UTF8', '--locale=C'],
});
if (fresh) await postgres.initialise();
await postgres.start();
if (fresh) await postgres.createDatabase(DATABASE);
const url = `postgresql://${USER}:${PASSWORD}@127.0.0.1:${PORT}/${DATABASE}`;
process.env.DATABASE_URL = url;
process.env.ANON_LEDGER_DIR = path.resolve('.demo/ledger');

const migrated = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/migrate.ts', 'up'], {
  env: { ...process.env },
  encoding: 'utf8',
});
console.log(migrated.stdout, migrated.stderr);

if (fresh) {
  const { db, withTx, sql } = await import('../src/repo/db.js');
  const authRepo = await import('../src/repo/auth.js');
  const classService = await import('../src/services/class.js');
  const studentService = await import('../src/services/students.js');
  const pointsService = await import('../src/services/points.js');
  const markService = await import('../src/services/marks.js');
  const layoutService = await import('../src/services/layout.js');

  const teacher = await withTx(db, (tx) => authRepo.createTeacher(tx, { username: 'teacher', password: 'teacher-demo-2026' }));
  const actor = teacher.teacher_id;
  const term = await classService.createTerm(actor, { name: '2026 秋季', request_id: randomUUID() });
  await classService.activateTerm(actor, term.term_id, { expected_current_term_id: null, request_id: randomUUID() });

  const surnames = '王李张刘陈杨黄赵吴周徐孙马朱胡郭何林高罗郑梁谢宋唐许韩冯邓曹彭曾肖田董潘袁蔡蒋余于杜叶程魏苏吕丁任卢姚沈钟姜崔谭陆范汪廖石金韦贾夏付方邹熊白孟秦邱侯江尹薛闫段雷龙黎史陶贺毛郝顾龚邵万覃武钱戴严欧莫孔向汤';
  const given = ['子涵', '欣怡', '浩然', '梓萱', '宇轩', '一诺', '俊熙', '诗涵', '思远', '雨桐', '晨阳', '可馨', '博文', '语嫣', '天佑', '若曦', '嘉懿', '明哲', '书瑶', '皓轩', '佳琪', '泽宇', '梦琪', '子墨', '安然', '昊天', '雅静', '奕辰', '心怡', '锦程'];
  const layout = await layoutService.getLayout();
  const slots = [...layout.slots].sort((a, b) => (a.seat_number ?? 0) - (b.seat_number ?? 0));

  const templates = [
    ['回答问题', 1, 2],
    ['认真操作', 1, 1],
    ['帮助同学', 1, 1],
    ['作品优秀', 1, 3],
    ['课堂讲话', -1, -1],
    ['玩游戏', -1, -2],
  ] as const;
  const tplIds: string[] = [];
  for (const [i, [name, polarity, delta]] of templates.entries()) {
    const t = await pointsService.createGlobalTemplate(actor, { name, polarity, default_delta: delta, sort_order: i, request_id: randomUUID() });
    tplIds.push((t as { template_id: string }).template_id);
  }

  const star = await markService.createMark(actor, { name: '课代表', icon: '★', color: '#6366F1', request_id: randomUUID() });
  const glasses = await markService.createMark(actor, { name: '坐前排', icon: '◎', color: '#0EA5E9', request_id: randomUUID() });

  for (const [ci, className] of ['七年级 1 班', '七年级 2 班'].entries()) {
    const cls = await classService.createClass(actor, { name: className, request_id: randomUUID() });
    const count = ci === 0 ? 50 : 46;
    const empty = new Set(ci === 0 ? [9, 22, 36, 50] : [3, 7, 15, 27, 33, 41, 48, 53]);
    const ids: string[] = [];
    let n = 0;
    for (const slot of slots) {
      if (empty.has(slot.seat_number ?? 0) || n >= count) continue;
      const fresh = await classService.requireClass(cls.class_id);
      const name = surnames[(n * 7 + ci * 13) % surnames.length]! + given[(n * 11 + ci * 5) % given.length]!;
      const s = await studentService.createStudent(actor, cls.class_id, {
        student_no: `2026${String(ci + 1).padStart(2, '0')}${String(n + 1).padStart(2, '0')}`,
        name,
        remark: n % 9 === 0 ? '家长电话需核对' : null,
        seat_id: slot.seat_id,
        expected_version: Number(fresh.seat_version),
        request_id: randomUUID(),
      });
      ids.push(s.student_id);
      n += 1;
    }
    for (let b = 0; b < 40; b++) {
      const size = b % 5 === 0 ? 4 : 1;
      const picked = Array.from({ length: size }, (_, k) => ids[(b * 17 + k * 5 + ci) % ids.length]!);
      const tpl = b % 7;
      const delta = tpl < 6 ? templates[tpl]![2] : (b % 2 ? 1 : -1);
      await pointsService.createBatch(actor, {
        request_id: randomUUID(),
        term_id: term.term_id,
        class_id: cls.class_id,
        student_ids: [...new Set(picked)],
        delta,
        template_id: tpl < 6 ? tplIds[tpl]! : null,
        note: null,
      });
      await new Promise((r) => setTimeout(r, 30));
    }
    await markService.addMark(actor, ids[0]!, (star as { mark_id: string }).mark_id, randomUUID());
    await markService.addMark(actor, ids[5]!, (glasses as { mark_id: string }).mark_id, randomUUID());

    const line = await db.execute<{ line_id: string }>(sql`INSERT INTO duty_line (class_id) VALUES (${cls.class_id}) RETURNING line_id`);
    for (const idx of [2, 8, 14, 20, 27]) {
      await db.execute(sql`INSERT INTO duty_term (line_id, student_id, seq_no, completed_count) VALUES (${line[0]!.line_id}, ${ids[idx]!}, 1, ${idx % 3})`);
    }
  }
  console.log('seeded');
}

const { buildServer } = await import('../src/server.js');
const app = await buildServer();
await app.listen({ port: 3000, host: '127.0.0.1' });
console.log('DEMO API READY on 3000');

const stop = async () => {
  await app.close().catch(() => undefined);
  await postgres.stop().catch(() => undefined);
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
