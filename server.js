const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const cron = require('node-cron');
const moment = require('moment');
const path = require('path');

const app = express();
app.use(cors({ limit: '50mb' }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public'))); 

const db = new sqlite3.Database('./database.sqlite', (err) => {
    if (err) console.error(err.message);
    console.log('✅ เชื่อมต่อฐานข้อมูลสำเร็จ');
});

// ตารางคลังอุปกรณ์ 
db.run(`CREATE TABLE IF NOT EXISTS inventory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    detail TEXT,
    quantity INTEGER DEFAULT 1
)`);
db.run(`ALTER TABLE inventory ADD COLUMN quantity INTEGER DEFAULT 1`, (err) => {});

// ตารางประวัติการยืม 
db.run(`CREATE TABLE IF NOT EXISTS records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fullName TEXT,
    email TEXT,
    faculty TEXT,
    studentId TEXT,
    phone TEXT,
    items TEXT,
    borrowQty INTEGER DEFAULT 1,
    borrowDate TEXT,
    returnDate TEXT,
    photoData TEXT,
    status TEXT,
    returnedAt TEXT
)`);
db.run(`ALTER TABLE records ADD COLUMN returnedAt TEXT`, (err) => {});
db.run(`ALTER TABLE records ADD COLUMN borrowQty INTEGER DEFAULT 1`, (err) => {});

// ล็อกอิน Admin
app.post('/api/login', (req, res) => {
    const { password } = req.body;
    if (password === 'tsu1234') {
        res.json({ success: true, token: 'TSU_ADMIN_TOKEN' });
    } else {
        res.status(401).json({ success: false, message: 'รหัสผ่านไม่ถูกต้อง' });
    }
});

// ดึงรายการอุปกรณ์ 
app.get('/api/items', (req, res) => {
    db.all(`SELECT * FROM inventory ORDER BY id DESC`, [], (err, items) => {
        if (err) return res.status(500).json({ error: err.message });
        
        db.all(`SELECT items, borrowQty FROM records WHERE status = 'pending'`, [], (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            
            const result = items.map(item => {
                const borrowedCount = rows
                    .filter(r => r.items === item.name || r.items.startsWith(item.name + ' (จำนวน:'))
                    .reduce((sum, r) => sum + (r.borrowQty || 1), 0);
                
                const qty = item.quantity || 1;
                const availableCount = qty - borrowedCount;
                
                return {
                    id: item.id,
                    name: item.name,
                    detail: item.detail,
                    quantity: qty,
                    isAvailable: availableCount > 0, 
                    availableCount: availableCount
                };
            });
            res.json(result);
        });
    });
});

// Admin: เพิ่มของ
app.post('/api/inventory', (req, res) => {
    const { name, detail, quantity } = req.body;
    db.run(`INSERT INTO inventory (name, detail, quantity) VALUES (?, ?, ?)`, 
        [name, detail || '', quantity || 1], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, id: this.lastID });
    });
});

// Admin: แก้ไขอุปกรณ์ 
app.put('/api/inventory/:id', (req, res) => {
    const { name, detail, quantity } = req.body;
    db.run(`UPDATE inventory SET name = ?, detail = ?, quantity = ? WHERE id = ?`, 
        [name, detail || '', quantity || 1, req.params.id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

// Admin: ลบของ
app.delete('/api/inventory/:id', (req, res) => {
    db.run(`DELETE FROM inventory WHERE id = ?`, [req.params.id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

// 🟢 ยืนยันการยืมของ (เอา Nodemailer ออก ตัดจบแค่บันทึกลงฐานข้อมูล)
app.post('/api/borrow', (req, res) => {
    let { fullName, email, faculty, studentId, phone, items, borrowQty, borrowDate, returnDate, photoData } = req.body;
    const cleanEmail = email.trim(); 
    const finalQty = borrowQty || 1;
    
    const sql = `INSERT INTO records (fullName, email, faculty, studentId, phone, items, borrowQty, borrowDate, returnDate, photoData, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`;
    
    db.run(sql, [fullName, cleanEmail, faculty, studentId || '-', phone, items, finalQty, borrowDate, returnDate, photoData], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        
        res.json({ success: true });
    });
});

app.get('/api/records', (req, res) => {
    db.all(`SELECT * FROM records ORDER BY id DESC`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// Admin กดรับคืน 
app.put('/api/return/:id', (req, res) => {
    const returnedTime = new Date().toISOString();
    db.run(`UPDATE records SET status = 'returned', returnedAt = ? WHERE id = ?`, [returnedTime, req.params.id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

// ==========================================
// ระบบทำงานอัตโนมัติ (Cron Jobs)
// ==========================================

// 1. ระบบลบประวัติ 24 ชม. 
cron.schedule('0 * * * *', () => {
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    
    db.run(`DELETE FROM records WHERE status = 'returned' AND returnedAt < ?`, [twentyFourHoursAgo], function(err) {
        if (err) console.error("❌ Error auto-deleting:", err.message);
        else if (this.changes > 0) console.log(`🗑️ ลบประวัติการคืนที่เกิน 24 ชม. อัตโนมัติสำเร็จจำนวน ${this.changes} รายการ`);
    });
});

// เปลี่ยน PORT เป็นค่าจาก Render หรือ 3000
app.listen(process.env.PORT || 3000, () => console.log('🚀 TSU Server running at port ' + (process.env.PORT || 3000)));
