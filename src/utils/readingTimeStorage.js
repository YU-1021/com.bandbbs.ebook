import storage from '../utils/storage.js';

const READING_TIME_KEY = 'EBOOK_READING_TIME_DATA';
const RECORDING_ENABLED_KEY = 'EBOOK_READING_TIME_RECORDING';

const MAX_RECENT_SESSIONS = 60;
const COMPRESS_BATCH_SIZE = 20;
const SAVE_DEBOUNCE_MS = 1500;

let currentReadingBook = null;
let sessionStartTime = 0;
let readingTimeCache = null;
let recordingEnabledCache = null;
let saveTimer = null;
let saveInFlight = false;
let dirty = false;
let pendingSavePromise = null;
let pendingSaveResolve = null;
let pendingSaveReject = null;

function storagePromise(method, params = {}) {
    return new Promise((resolve) => {
        storage[method]({
            ...params,
            success: (data) => resolve({ status: 'success', data }),
            fail: (data, code) => resolve({ status: 'fail', code })
        });
    });
}

function normalizeDateString(date) {
    return date.toISOString().split('T')[0];
}

function todayDateString() {
    return normalizeDateString(new Date());
}

async function isReadingTimeRecordingEnabled() {
    if (recordingEnabledCache !== null) {
        return recordingEnabledCache;
    }
    const result = await storagePromise('get', { key: RECORDING_ENABLED_KEY });
    if (result.status === 'success' && result.data !== undefined && result.data !== '') {
        recordingEnabledCache = result.data === 'true';
    } else {
        recordingEnabledCache = true;
    }
    return recordingEnabledCache;
}

function toSafeNumber(value, fallback = 0) {
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
}

function ensureBookData(bookData) {
    if (!bookData || typeof bookData !== 'object') {
        return {
            totalSeconds: 0,
            sessionCount: 0,
            sessions: [],
            dailySeconds: {},
            lastReadDate: null,
            firstReadDate: null
        };
    }

    if (!Array.isArray(bookData.sessions)) bookData.sessions = [];
    if (!bookData.dailySeconds || typeof bookData.dailySeconds !== 'object') bookData.dailySeconds = {};
    if (typeof bookData.totalSeconds !== 'number') bookData.totalSeconds = toSafeNumber(bookData.totalSeconds, 0);
    if (typeof bookData.sessionCount !== 'number') bookData.sessionCount = Array.isArray(bookData.sessions) ? bookData.sessions.length : 0;
    if (!('lastReadDate' in bookData)) bookData.lastReadDate = null;
    if (!('firstReadDate' in bookData)) bookData.firstReadDate = null;

    return bookData;
}

function compactBookSessions(bookData) {
    if (!bookData || !Array.isArray(bookData.sessions)) return bookData;

    if (bookData.sessions.length <= MAX_RECENT_SESSIONS) return bookData;

    const overflow = bookData.sessions.length - MAX_RECENT_SESSIONS;
    const compressCount = Math.max(COMPRESS_BATCH_SIZE, overflow);
    const toCompress = bookData.sessions.splice(0, compressCount);

    if (!bookData.dailySeconds || typeof bookData.dailySeconds !== 'object') {
        bookData.dailySeconds = {};
    }

    toCompress.forEach(session => {
        if (!session || !session.date) return;
        const duration = toSafeNumber(session.duration, 0);
        if (!Number.isFinite(duration) || duration <= 0) return;
        bookData.dailySeconds[session.date] = (toSafeNumber(bookData.dailySeconds[session.date], 0)) + duration;
    });

    return bookData;
}

async function getAllReadingTime() {
    if (readingTimeCache !== null) {
        return readingTimeCache;
    }

    const result = await storagePromise('get', { key: READING_TIME_KEY });
    if (result.status === 'success' && result.data) {
        try {
            const parsed = JSON.parse(result.data);
            const normalized = {};
            Object.keys(parsed || {}).forEach(bookName => {
                const bookData = ensureBookData(parsed[bookName]);
                normalized[bookName] = compactBookSessions(bookData);
            });
            readingTimeCache = normalized;
            return readingTimeCache;
        } catch (e) {
            readingTimeCache = {};
            return readingTimeCache;
        }
    }

    readingTimeCache = {};
    return readingTimeCache;
}

function doSaveReadingTime(readingTimeData) {
    return new Promise((resolve, reject) => {
        storage.set({
            key: READING_TIME_KEY,
            value: JSON.stringify(readingTimeData),
            success: () => resolve(),
            fail: () => reject()
        });
    });
}

function flushPendingSave() {
    if (!dirty || !readingTimeCache) {
        if (pendingSaveResolve) {
            pendingSaveResolve();
            pendingSaveResolve = null;
            pendingSaveReject = null;
            pendingSavePromise = null;
        }
        return Promise.resolve();
    }

    if (saveInFlight) {
        return pendingSavePromise || Promise.resolve();
    }

    saveInFlight = true;

    const savePromise = doSaveReadingTime(readingTimeCache)
        .then(() => {
            dirty = false;
            saveInFlight = false;
            if (pendingSaveResolve) {
                pendingSaveResolve();
                pendingSaveResolve = null;
                pendingSaveReject = null;
                pendingSavePromise = null;
            }
        })
        .catch((err) => {
            saveInFlight = false;
            if (pendingSaveReject) {
                pendingSaveReject(err);
                pendingSaveResolve = null;
                pendingSaveReject = null;
                pendingSavePromise = null;
            }
        });

    pendingSavePromise = savePromise;
    return savePromise;
}

function scheduleSave() {
    dirty = true;

    if (!pendingSavePromise) {
        pendingSavePromise = new Promise((resolve, reject) => {
            pendingSaveResolve = resolve;
            pendingSaveReject = reject;
        });
    }

    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        saveTimer = null;
        flushPendingSave();
    }, SAVE_DEBOUNCE_MS);

    return pendingSavePromise;
}

function upsertSession(bookData, session) {
    bookData.sessions.push(session);
    compactBookSessions(bookData);
}

function updateAggregates(bookData, duration, sessionDate, startTime, endTime) {
    const safeDuration = Math.max(0, toSafeNumber(duration, 0));
    bookData.totalSeconds = Math.max(0, toSafeNumber(bookData.totalSeconds, 0)) + safeDuration;
    bookData.sessionCount = Math.max(0, toSafeNumber(bookData.sessionCount, 0)) + 1;
    bookData.lastReadDate = sessionDate;
    if (!bookData.firstReadDate) bookData.firstReadDate = sessionDate;

    bookData.dailySeconds[sessionDate] = Math.max(0, toSafeNumber(bookData.dailySeconds[sessionDate], 0)) + safeDuration;

    upsertSession(bookData, {
        startTime,
        endTime,
        duration: safeDuration,
        date: sessionDate
    });
}

async function persistSession(bookName, endTime, options = {}) {
    const { minimumDuration = 10, resetSession = true } = options;

    if (!bookName || sessionStartTime === 0) return false;

    const duration = Math.floor((endTime - sessionStartTime) / 1000);

    if (duration < minimumDuration) {
        if (resetSession) {
            sessionStartTime = 0;
            currentReadingBook = null;
        }
        return false;
    }

    try {
        const readingTimeData = await getAllReadingTime();
        let bookData = ensureBookData(readingTimeData[bookName]);
        readingTimeData[bookName] = bookData;

        const sessionDate = todayDateString();
        updateAggregates(bookData, duration, sessionDate, sessionStartTime, endTime);

        if (resetSession) {
            sessionStartTime = 0;
            currentReadingBook = null;
        } else {
            sessionStartTime = endTime;
            currentReadingBook = bookName;
        }

        await scheduleSave();
        return true;
    } catch (e) {
        return false;
    }
}

async function recordReadingStart(bookName) {
    if (!bookName) return;
    if (!(await isReadingTimeRecordingEnabled())) return;

    if (currentReadingBook && currentReadingBook !== bookName && sessionStartTime > 0) {
        await persistSession(currentReadingBook, Date.now(), { minimumDuration: 0, resetSession: true });
    }

    currentReadingBook = bookName;
    sessionStartTime = Date.now();
}

async function recordReadingEnd(bookName) {
    if (!bookName) return;
    if (!(await isReadingTimeRecordingEnabled())) return;

    if (sessionStartTime === 0) {
        currentReadingBook = null;
        return;
    }

    const targetBookName = currentReadingBook || bookName;
    if (targetBookName !== bookName) return;

    await persistSession(targetBookName, Date.now(), { minimumDuration: 10, resetSession: true });
}

async function saveCurrentSession(bookName) {
    if (!bookName) return;
    if (!(await isReadingTimeRecordingEnabled())) return;

    if (currentReadingBook !== bookName || sessionStartTime === 0) {
        currentReadingBook = bookName;
        sessionStartTime = Date.now();
        return;
    }

    await persistSession(bookName, Date.now(), { minimumDuration: 10, resetSession: false });
}

async function getReadingTime(bookName) {
    if (!bookName) return null;
    try {
        const data = await getAllReadingTime();
        return data[bookName] || null;
    } catch (e) {
        return null;
    }
}

function formatDuration(seconds) {
    const safeSeconds = Math.max(0, Math.floor(toSafeNumber(seconds, 0)));
    if (safeSeconds === 0) return '0分钟';

    const hours = Math.floor(safeSeconds / 3600);
    const minutes = Math.floor((safeSeconds % 3600) / 60);
    const secs = safeSeconds % 60;
    if (hours > 0) {
        return minutes > 0 ? `${hours}小时${minutes}分钟` : `${hours}小时`;
    }
    if (minutes > 0) return `${minutes}分钟`;
    return `${secs}秒`;
}

function getTodayDateString() {
    return todayDateString();
}

function getWeekStartDate() {
    const today = new Date();
    const day = today.getDay();
    const diff = today.getDate() - day + (day === 0 ? -6 : 1);
    const monday = new Date(today.setDate(diff));
    monday.setHours(0, 0, 0, 0);
    return monday.toISOString().split('T')[0];
}

function getLast7DaysDateStrings() {
    const dates = [];
    const today = new Date();
    for (let i = 6; i >= 0; i--) {
        const date = new Date(today);
        date.setDate(today.getDate() - i);
        dates.push(date.toISOString().split('T')[0]);
    }
    return dates;
}

function calculateStatsFromDaily(dailySeconds = {}, sessions = [], totalSecondsOverride) {
    const today = getTodayDateString();
    const weekStart = getWeekStartDate();
    const dailyTotals = {};
    let totalSeconds = totalSecondsOverride !== undefined ? Math.max(0, toSafeNumber(totalSecondsOverride, 0)) : 0;
    let todaySeconds = 0;
    let weekSeconds = 0;
    let maxDailySeconds = 0;
    const totalDays = new Set();
    let firstDate = null;
    let lastDate = null;

    const dailyKeys = Object.keys(dailySeconds || {});
    if (dailyKeys.length > 0) {
        dailyKeys.forEach(date => {
            const seconds = Math.max(0, toSafeNumber(dailySeconds[date], 0));
            dailyTotals[date] = seconds;
            totalDays.add(date);

            if (totalSecondsOverride === undefined) {
                totalSeconds += seconds;
            }
            if (date === today) todaySeconds += seconds;
            if (date >= weekStart) weekSeconds += seconds;
            if (!firstDate || date < firstDate) firstDate = date;
            if (!lastDate || date > lastDate) lastDate = date;
        });
    } else if (sessions && sessions.length > 0) {
        const calcTotal = totalSecondsOverride === undefined;
        sessions.forEach(session => {
            const date = session.date;
            if (!date) return;
            const duration = Math.max(0, toSafeNumber(session.duration, 0));

            if (calcTotal) totalSeconds += duration;
            totalDays.add(date);
            dailyTotals[date] = (dailyTotals[date] || 0) + duration;
            if (date === today) todaySeconds += duration;
            if (date >= weekStart) weekSeconds += duration;
            if (!firstDate || date < firstDate) firstDate = date;
            if (!lastDate || date > lastDate) lastDate = date;
        });
    }

    Object.values(dailyTotals).forEach(val => {
        if (val > maxDailySeconds) maxDailySeconds = val;
    });

    let totalWeeks = 1;
    if (firstDate && lastDate) {
        const first = new Date(firstDate);
        const last = new Date(lastDate);
        const daysDiff = Math.ceil((last - first) / (1000 * 60 * 60 * 24)) + 1;
        totalWeeks = Math.ceil(daysDiff / 7) || 1;
    }

    const totalDaysCount = totalDays.size || 1;

    return {
        totalSeconds,
        totalDays: totalDays.size,
        todaySeconds,
        weekSeconds,
        averageDailySeconds: Math.floor(totalSeconds / totalDaysCount),
        averageWeekSeconds: Math.floor(totalSeconds / totalWeeks),
        maxDailySeconds,
        firstDate,
        lastDate,
        sessionCount: sessions.length
    };
}

function calculateGlobalStats(allBooksData) {
    let combinedDailySeconds = {};
    let combinedTotalSeconds = 0;
    let combinedSessions = [];

    Object.values(allBooksData || {}).forEach(bookData => {
        if (!bookData) return;
        if (bookData.totalSeconds) combinedTotalSeconds += bookData.totalSeconds;

        if (bookData.dailySeconds && typeof bookData.dailySeconds === 'object') {
            Object.entries(bookData.dailySeconds).forEach(([date, seconds]) => {
                combinedDailySeconds[date] = (combinedDailySeconds[date] || 0) + (seconds || 0);
            });
        } else if (bookData.sessions && bookData.sessions.length > 0) {
            combinedSessions = combinedSessions.concat(bookData.sessions);
        }
    });

    if (Object.keys(combinedDailySeconds).length > 0) {
        return calculateStatsFromDaily(combinedDailySeconds, [], combinedTotalSeconds);
    }
    return calculateStatsFromDaily({}, combinedSessions, combinedTotalSeconds);
}

function calculateBookStats(bookData) {
    if (!bookData) return calculateStatsFromDaily({}, []);
    const normalized = ensureBookData(bookData);
    const stats = calculateStatsFromDaily(normalized.dailySeconds || {}, normalized.sessions || [], normalized.totalSeconds);
    stats.firstReadDate = normalized.firstReadDate || '';
    stats.lastReadDate = normalized.lastReadDate || '';
    return stats;
}

function getLast7DaysReadingTime(sessionsOrBookData) {
    const dates = getLast7DaysDateStrings();
    const dailyData = {};
    dates.forEach(date => {
        dailyData[date] = 0;
    });

    if (!sessionsOrBookData) {
        return dates.map(date => 0);
    }

    if (sessionsOrBookData.dailySeconds && typeof sessionsOrBookData.dailySeconds === 'object') {
        dates.forEach(date => {
            dailyData[date] = Math.max(0, toSafeNumber(sessionsOrBookData.dailySeconds[date], 0));
        });
        return dates.map(date => Math.floor(dailyData[date] / 60));
    }

    if (Array.isArray(sessionsOrBookData)) {
        sessionsOrBookData.forEach(session => {
            const date = session.date;
            if (dailyData.hasOwnProperty(date)) {
                dailyData[date] += Math.max(0, toSafeNumber(session.duration, 0));
            }
        });
        return dates.map(date => Math.floor(dailyData[date] / 60));
    }

    return dates.map(date => 0);
}

function getLast7DaysGlobalReadingTime(allBooksData) {
    const dates = getLast7DaysDateStrings();
    const dailyData = {};
    dates.forEach(date => {
        dailyData[date] = 0;
    });

    Object.values(allBooksData || {}).forEach(bookData => {
        if (!bookData) return;

        if (bookData.dailySeconds && typeof bookData.dailySeconds === 'object') {
            dates.forEach(date => {
                dailyData[date] += Math.max(0, toSafeNumber(bookData.dailySeconds[date], 0));
            });
        } else if (bookData.sessions && bookData.sessions.length > 0) {
            bookData.sessions.forEach(session => {
                const date = session.date;
                if (dailyData.hasOwnProperty(date)) {
                    dailyData[date] += Math.max(0, toSafeNumber(session.duration, 0));
                }
            });
        }
    });

    return dates.map(date => Math.floor(dailyData[date] / 60));
}

async function saveReadingTime(readingTimeData) {
    readingTimeCache = readingTimeData || {};
    dirty = false;

    if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
    }

    return doSaveReadingTime(readingTimeCache);
}

async function clearAllReadingTime() {
    readingTimeCache = {};
    currentReadingBook = null;
    sessionStartTime = 0;
    dirty = false;

    if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
    }

    return new Promise((resolve, reject) => {
        storage.set({
            key: READING_TIME_KEY,
            value: JSON.stringify({}),
            success: () => resolve(),
            fail: () => reject()
        });
    });
}

export default {
    recordReadingStart,
    recordReadingEnd,
    saveCurrentSession,
    getReadingTime,
    getAllBooksReadingTime: getAllReadingTime,
    saveReadingTime,
    formatDuration,
    calculateGlobalStats,
    calculateBookStats,
    clearAllReadingTime,
    getLast7DaysReadingTime,
    getLast7DaysGlobalReadingTime
};
