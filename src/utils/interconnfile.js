import file from "@system.file";
import device from "@system.device";
import runAsyncFunc from "./runAsyncFunc";
import str2abWrite from "./str2abWrite";
import bookStorage from '../utils/bookStorage.js';
import readingTimeStorage from '../utils/readingTimeStorage.js';
import chapterManager from '../utils/chapterManager.js';
import { calculateStorageInfo } from '../utils/storageUtils.js';
import storage from '../utils/storage.js';

export default class interconnfile {
    static "__interconnModule__" = true;
    static name = 'file';

    baseUri = 'internal://files/books/';
    currentBookName = "";
    currentBookDir = "";
    totalChapters = 0;
    receivedChapters = 0;
    currentSavingChapterIndex = -1;
    currentChapterMeta = null;
    isCoverOnly = false;
    syncedChapterIndices = new Set();
    currentBookCoverUri = null;
    currentIllustrationUri = null;
    currentIllustrationRelativePath = "";
    pendingChapterMetas = [];
    BATCH_WRITE_SIZE = 15;
    CHAPTERS_PER_FILE = 100;
    lindexContent = null;

    chapterWriteState = new Map();
    illustrationWriteState = new Map();
    
    dirtyLindex = false;
    lastLindexFlushTime = 0;
    LINDEX_FLUSH_INTERVAL = 5000;

    flushingMetas = false;

    constructor({ addListener, send, setEventListener }) {
        this.send = send;
        const onmessage = async (data) => {
            const { stat, ...payload } = data;
            try {
                switch (stat) {
                    case "startTransfer":
                        this.isCoverOnly = false;
                        await this.startTransfer(payload);
                        break;
                    case "start_cover_transfer":
                        this.isCoverOnly = true;
                        await this.startCoverTransfer(payload);
                        break;
                    case "start_illustration_transfer":
                        await this.startIllustrationTransfer(payload);
                        break;
                    case "d":
                        await this.saveChapter(payload);
                        break;
                    case "chapter_complete":
                        await this.completeChapterTransfer(payload);
                        break;
                    case "transfer_complete":
                        await this.handleTransferComplete();
                        break;
                    case "cancel":
                        await this.handleCancel();
                        break;
                    case "get_book_status":
                        await this.getBookStatus(payload);
                        break;
                    case "cover_chunk":
                        await this.saveCoverChunk(payload);
                        break;
                    case "cover_transfer_complete":
                        await this.completeCoverTransfer();
                        break;
                    case "illustration_chunk":
                        await this.saveIllustrationChunk(payload);
                        break;
                    case "illustration_transfer_complete":
                        await this.completeIllustrationTransfer(payload);
                        break;
                    case "update_book_info":
                        await this.updateBookInfo(payload);
                        break;
                    case "get_reading_data":
                        await this.getReadingData(payload);
                        break;
                    case "set_reading_data":
                        await this.setReadingData(payload);
                        break;
                    case "delete_chapters":
                        await this.deleteChapters(payload);
                        break;
                    case "delete_book":
                        await this.deleteBook(payload);
                        break;
                    case "get_storage_info":
                        await this.getStorageInfo();
                        break;
                    case "get_settings":
                        await this.getSettings(payload);
                        break;
                    case "set_settings":
                        await this.setSettings(payload);
                        break;
                }
            } catch (e) {
                this.handleError(e, "Message processing error");
            }
        };

        addListener(onmessage);

        setEventListener((event) => {
            if (event !== 'open') {
                if (this.pendingChapterMetas.length > 0) {
                    this.flushPendingChapterMetas().catch(() => {});
                }
                this.resetState();
                this.callback({ msg: "error", error: event, filename: this.currentBookName });
            }
        });
    }

    resetState() {
        this.currentBookName = "";
        this.currentBookDir = "";
        this.lindexContent = null;
        this.pendingChapterMetas = [];
        this.currentBookCoverUri = null;
        this.currentIllustrationUri = null;
        this.currentIllustrationRelativePath = "";
        this.currentChapterMeta = null;
        this.currentSavingChapterIndex = -1;
        this.chapterWriteState.clear();
        this.illustrationWriteState.clear();
        this.dirtyLindex = false;
        this.lastLindexFlushTime = 0;
        this.flushingMetas = false;
    }

    async handleCancel() {
        if (this.pendingChapterMetas.length > 0) {
            await this.flushPendingChapterMetas().catch(() => {});
        }
        await this.flushLindexIfNeeded(true).catch(() => {});
        this.send({ type: "cancel" });
        this.resetState();
        this.callback({ msg: "cancel" });
    }

    async ensureDir(uri) {
        try {
            await runAsyncFunc(file.access, { uri });
        } catch (e) {
            await runAsyncFunc(file.mkdir, { uri, recursive: true });
        }
    }

    async clearCache() {
        try {
            await runAsyncFunc(file.delete, { uri: this.baseUri + 'temp_cover.jpg' });
        } catch (e) {}
    }

    generateDirName(filename) {
        let hash = 0;
        if (!filename || filename.length === 0) return '00000000';
        for (let i = 0; i < filename.length; i++) {
            hash = ((hash << 5) - hash) + filename.charCodeAt(i);
            hash = hash & hash;
        }
        return (hash >>> 0).toString(16).padStart(8, '0');
    }

    generateCoverFileName() {
        return `cover_${Math.random().toString(36).substring(2, 10)}.jpg`;
    }

    normalizeIllustrationRelativePath(relativePath) {
        const normalizedPath = (relativePath || '').replace(/^\/+/, '');
        const pathParts = normalizedPath.split('/').filter(Boolean);
        if (pathParts.length === 0 || pathParts.some(part => part === '.' || part === '..')) {
            throw new Error('插图路径无效');
        }
        return pathParts.join('/');
    }

    async getBookStatus({ filename }) {
        try {
            await runAsyncFunc(file.access, { uri: this.baseUri });
        } catch (e) {
            this.send({ type: "book_status", syncedChapters: [], hasCover: false });
            return;
        }

        const sanitizedDirName = this.generateDirName(filename);
        const bookDir = `${this.baseUri}${sanitizedDirName}`;

        let syncedChapterIndices = [];
        let hasCover = false;

        try {
            const lindexData = await runAsyncFunc(file.readText, { uri: `${bookDir}/lindex.txt` });
            const totalChapters = parseInt(lindexData.text.split('\n')[0], 10);
            if (!isNaN(totalChapters)) {
                const numChunks = Math.ceil(totalChapters / this.CHAPTERS_PER_FILE);
                const indexSet = new Set();
                const indexesDirUri = `${bookDir}/indexes/`;
                for (let i = 1; i <= numChunks; i++) {
                    try {
                        const chunkData = await runAsyncFunc(file.readText, { uri: `${indexesDirUri}${i}.txt` });
                        chunkData.text.split('\n').forEach(line => {
                            if (!line) return;
                            const idx = parseInt(line.split('\t')[0], 10);
                            if (!isNaN(idx)) indexSet.add(idx);
                        });
                    } catch (e) {}
                }
                syncedChapterIndices = Array.from(indexSet);
            }
        } catch (e) {}

        try {
            const bookInfoData = await runAsyncFunc(file.readText, { uri: `${bookDir}/book_info.json` });
            const bookInfo = JSON.parse(bookInfoData.text);
            if (bookInfo.coverFileName) {
                await runAsyncFunc(file.access, { uri: `${bookDir}/${bookInfo.coverFileName}` });
                hasCover = true;
            }
        } catch (e) {
            hasCover = false;
        }

        this.send({ type: "book_status", syncedChapters: syncedChapterIndices, hasCover });
    }

    async startCoverTransfer({ filename }) {
        this.currentBookName = filename;
        this.currentBookDir = this.generateDirName(filename);
        await this.ensureDir(this.baseUri);
        const bookUri = this.baseUri + this.currentBookDir;
        await this.ensureDir(bookUri);

        const bookInfoUri = bookUri + '/book_info.json';
        let bookInfo = {};
        try {
            const bookInfoData = await runAsyncFunc(file.readText, { uri: bookInfoUri });
            bookInfo = JSON.parse(bookInfoData.text);
            if (bookInfo.coverFileName) {
                await runAsyncFunc(file.delete, { uri: bookUri + '/' + bookInfo.coverFileName }).catch(() => {});
            }
        } catch (e) {}

        const newCoverFileName = this.generateCoverFileName();
        bookInfo.coverFileName = newCoverFileName;
        bookInfo.hasCover = true;
        await runAsyncFunc(file.writeText, { uri: bookInfoUri, text: JSON.stringify(bookInfo) });

        const bookshelf = await bookStorage.getBooks();
        const bookIndex = bookshelf.findIndex(b => b.dirName === this.currentBookDir);
        if (bookIndex > -1) {
            bookshelf[bookIndex].coverFileName = newCoverFileName;
            bookshelf[bookIndex].hasCover = true;
            await bookStorage.updateBooks(bookshelf);
        }

        this.currentBookCoverUri = bookUri + '/' + newCoverFileName;
        this.send({ type: "cover_ready" });
    }

    async rebuildSyncedIndices() {
        this.syncedChapterIndices.clear();
        const indexesDirUri = `${this.baseUri}${this.currentBookDir}/indexes/`;
        try {
            const { fileList } = await runAsyncFunc(file.list, { uri: indexesDirUri });
            if (fileList) {
                for (const f of fileList) {
                    if (!f.uri.endsWith('.txt')) continue;
                    try {
                        const text = await runAsyncFunc(file.readText, { uri: f.uri });
                        text.text.split('\n').forEach(line => {
                            if (!line.trim()) return;
                            const index = parseInt(line.split('\t')[0], 10);
                            if (!isNaN(index)) this.syncedChapterIndices.add(index);
                        });
                    } catch (e) {}
                }
            }
        } catch (e) {}
        this.receivedChapters = this.syncedChapterIndices.size;
    }

    async startTransfer({ filename, total, wordCount, startFrom = 0, hasCover = false, author, summary, bookStatus, category, localCategory }) {
        await this.clearCache();

        this.currentBookName = filename;
        this.currentBookDir = this.generateDirName(filename);
        this.totalChapters = total;
        this.receivedChapters = startFrom;
        this.pendingChapterMetas = [];
        this.lindexContent = null;
        this.syncedChapterIndices.clear();
        this.chapterWriteState.clear();
        this.dirtyLindex = false;
        this.lastLindexFlushTime = 0;
        this.flushingMetas = false;

        this.callback({ msg: "start", total, filename });

        await this.ensureDir(this.baseUri);
        const bookUri = this.baseUri + this.currentBookDir;
        const bookInfoUri = bookUri + '/book_info.json';
        const lindexUri = bookUri + '/lindex.txt';

        let coverFileName = hasCover ? this.generateCoverFileName() : null;

        await this.ensureDir(bookUri);
        await this.ensureDir(bookUri + '/indexes');
        await this.ensureDir(bookUri + '/content');

        try {
            const bookInfo = JSON.parse((await runAsyncFunc(file.readText, { uri: bookInfoUri })).text);
            if (bookInfo.coverFileName) coverFileName = bookInfo.coverFileName;
            if (bookInfo.hasCover && !hasCover) hasCover = true;
        } catch (e) {}

        await this.rebuildSyncedIndices();

        try {
            const lindexData = await runAsyncFunc(file.readText, { uri: lindexUri });
            let lines = lindexData.text.split('\n');
            lines[0] = total.toString();
            lines[1] = this.receivedChapters.toString();
            this.lindexContent = lines.join('\n');
        } catch (e) {
            this.lindexContent = this.generateLindexContent(total, this.receivedChapters);
        }
        await runAsyncFunc(file.writeText, { uri: lindexUri, text: this.lindexContent });

        const bookshelf = await bookStorage.getBooks();
        const existingBook = bookshelf.find(b => b.dirName === this.currentBookDir);
        if (!existingBook) {
            bookshelf.push({
                name: filename,
                dirName: this.currentBookDir,
                chapterCount: total,
                wordCount: wordCount,
                hasCover: hasCover,
                coverFileName: coverFileName,
                progress: {},
                localCategory: localCategory
            });
            await bookStorage.updateBooks(bookshelf);
        } else {
            existingBook.chapterCount = total;
            existingBook.wordCount = wordCount;
            if (hasCover) {
                existingBook.hasCover = hasCover;
                existingBook.coverFileName = coverFileName;
            }
            if (localCategory) existingBook.localCategory = localCategory;
            await bookStorage.updateBooks(bookshelf);
        }

        if (hasCover && coverFileName) {
            this.currentBookCoverUri = bookUri + '/' + coverFileName;
        }

        const bookInfo = {
            name: filename,
            chapterCount: total,
            wordCount,
            hasCover,
            coverFileName,
            author,
            summary,
            bookStatus,
            category,
            localCategory
        };
        await runAsyncFunc(file.writeText, { uri: bookInfoUri, text: JSON.stringify(bookInfo) });

        this.send({ type: "ready", count: startFrom, usage: 0 });
    }

    generateLindexContent(total, received) {
        let content = `${total}\n${received}\n`;
        const numChunks = Math.ceil(total / this.CHAPTERS_PER_FILE);
        for (let i = 0; i < numChunks; i++) {
            const start = i * this.CHAPTERS_PER_FILE;
            const end = Math.min(start + this.CHAPTERS_PER_FILE - 1, total - 1);
            content += `${start},${end}\n`;
        }
        return content;
    }

    handleError(error, context) {
        const errorMsg = error.message || '未知错误';
        let displayMsg = `${context}: ${errorMsg}`;
        if (errorMsg.match(/space|disk|full|storage|1300/i)) {
            displayMsg = "存储空间不足";
        }
        this.send({ type: "error", message: displayMsg, count: 0 });
        this.callback({ msg: "error", error: displayMsg });
    }

    async saveCoverChunk({ chunkIndex, data }) {
        if (chunkIndex === 0) {
            await runAsyncFunc(file.delete, { uri: this.currentBookCoverUri }).catch(() => {});
        }

        const coverBytes = this.base64ToArrayBuffer(data);
        if (coverBytes.byteLength > 0) {
            await runAsyncFunc(file.writeArrayBuffer, {
                uri: this.currentBookCoverUri,
                buffer: new Uint8Array(coverBytes),
                append: chunkIndex > 0,
            });
        }
        await this.send({ type: "cover_chunk_received" });
    }

    async completeCoverTransfer() {
        this.currentBookCoverUri = null;
        this.send({ type: "cover_saved" });
        if (this.isCoverOnly) {
            this.callback({ msg: "success" });
            this.resetState();
        }
        global.runGC();
    }

    async startIllustrationTransfer({ filename, relativePath }) {
        this.currentBookName = filename;
        this.currentBookDir = this.generateDirName(filename);
        await this.ensureDir(this.baseUri);
        const bookUri = this.baseUri + this.currentBookDir;
        await this.ensureDir(bookUri);

        const normalizedPath = this.normalizeIllustrationRelativePath(relativePath);
        const pathParts = normalizedPath.split('/');

        let currentDir = bookUri;
        for (let i = 0; i < pathParts.length - 1; i++) {
            currentDir = `${currentDir}/${pathParts[i]}`;
            await this.ensureDir(currentDir);
        }

        this.currentIllustrationRelativePath = normalizedPath;
        this.currentIllustrationUri = `${bookUri}/${normalizedPath}`;
        this.illustrationWriteState.set(normalizedPath, {
            started: false,
            completed: false,
            lastChunkNum: -1,
            totalChunks: 0
        });

        this.send({ type: "illustration_ready" });
    }

    async saveIllustrationChunk({ relativePath, chunkIndex, totalChunks, data }) {
        if (!this.currentIllustrationUri || !this.currentIllustrationRelativePath) {
            throw new Error('插图接收状态缺失');
        }

        const normalizedPath = this.normalizeIllustrationRelativePath(relativePath || this.currentIllustrationRelativePath);
        if (normalizedPath !== this.currentIllustrationRelativePath) {
            throw new Error('插图路径不匹配');
        }

        const state = this.illustrationWriteState.get(normalizedPath) || {
            started: false,
            completed: false,
            lastChunkNum: -1,
            totalChunks: 0
        };
        const isFirstChunk = chunkIndex === 0;

        if (state.completed && !isFirstChunk) {
            await this.send({ type: "illustration_chunk_received" });
            return;
        }

        if (isFirstChunk) {
            state.started = true;
            state.completed = false;
            state.lastChunkNum = -1;
            state.totalChunks = totalChunks || 0;
            try {
                await runAsyncFunc(file.delete, { uri: this.currentIllustrationUri });
            } catch (e) {}
        } else {
            if (!state.started) {
                throw new Error('插图首个分块缺失');
            }
            if (state.totalChunks && totalChunks && state.totalChunks !== totalChunks) {
                throw new Error('插图分块总数不一致');
            }
            if (chunkIndex <= state.lastChunkNum) {
                await this.send({ type: "illustration_chunk_received" });
                return;
            }
            if (chunkIndex !== state.lastChunkNum + 1) {
                throw new Error('插图分块顺序异常');
            }
        }

        const illustrationBytes = this.base64ToArrayBuffer(data);
        if (illustrationBytes.byteLength > 0) {
            await runAsyncFunc(file.writeArrayBuffer, {
                uri: this.currentIllustrationUri,
                buffer: new Uint8Array(illustrationBytes),
                append: !isFirstChunk,
            });
        }

        state.lastChunkNum = chunkIndex;
        if (state.totalChunks > 0 && chunkIndex === state.totalChunks - 1) {
            state.completed = true;
        }
        this.illustrationWriteState.set(normalizedPath, state);

        await this.send({ type: "illustration_chunk_received" });
    }

    async completeIllustrationTransfer({ relativePath }) {
        const normalizedPath = this.normalizeIllustrationRelativePath(relativePath || this.currentIllustrationRelativePath);
        const state = this.illustrationWriteState.get(normalizedPath);
        if (!state || !state.started) {
            throw new Error('插图传输未开始');
        }
        if (state.totalChunks > 0 && state.lastChunkNum !== state.totalChunks - 1) {
            throw new Error('插图传输未完成');
        }

        this.currentIllustrationUri = null;
        this.currentIllustrationRelativePath = "";
        this.send({ type: "illustration_saved" });
        global.runGC();
    }

    async updateBookInfo({ filename, author, summary, bookStatus, category, localCategory }) {
        const sanitizedDirName = this.generateDirName(filename);
        const bookUri = this.baseUri + sanitizedDirName;
        const bookInfoUri = bookUri + '/book_info.json';

        let bookInfo = {};
        try {
            bookInfo = JSON.parse((await runAsyncFunc(file.readText, { uri: bookInfoUri })).text);
        } catch (e) {}

        if (author != null) bookInfo.author = author;
        if (summary != null) bookInfo.summary = summary;
        if (bookStatus != null) bookInfo.bookStatus = bookStatus;
        if (category != null) bookInfo.category = category;
        if (localCategory !== undefined) bookInfo.localCategory = localCategory;

        if ((!bookInfo.localCategory) && bookInfo.category) {
            bookInfo.localCategory = bookInfo.category;
        }

        await runAsyncFunc(file.writeText, { uri: bookInfoUri, text: JSON.stringify(bookInfo) });

        try {
            const allBooks = await bookStorage.getBooks();
            const bookIndex = allBooks.findIndex(b => b.dirName === sanitizedDirName);
            if (bookIndex !== -1) {
                allBooks[bookIndex].localCategory = bookInfo.localCategory || null;
                await bookStorage.updateBooks(allBooks);
            }
        } catch (e) {}

        this.send({ type: "book_info_updated" });
        this.callback({ msg: "book_info_updated", filename });
    }

    base64ToArrayBuffer(base64) {
        base64 = base64.replace(/[\s\r\n]/g, '');
        const len = base64.length;
        if (len === 0) return new ArrayBuffer(0);

        const b64lookup = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let paddingCount = 0;
        if (base64.charAt(len - 1) === '=') paddingCount++;
        if (base64.charAt(len - 2) === '=') paddingCount++;

        const bufferLength = (len * 3 / 4) - paddingCount;
        const bytes = new Uint8Array(bufferLength);
        let p = 0;
        for (let i = 0; i < len; i += 4) {
            const encoded1 = b64lookup.indexOf(base64[i]);
            const encoded2 = b64lookup.indexOf(base64[i + 1]);
            const encoded3 = b64lookup.indexOf(base64[i + 2]);
            const encoded4 = b64lookup.indexOf(base64[i + 3]);

            if (encoded1 < 0 || encoded2 < 0) continue;

            bytes[p++] = (encoded1 << 2) | (encoded2 >> 4);
            if (encoded3 !== -1 && encoded3 !== 64 && p < bufferLength) {
                bytes[p++] = ((encoded2 & 15) << 4) | (encoded3 >> 2);
            }
            if (encoded4 !== -1 && encoded4 !== 64 && p < bufferLength) {
                bytes[p++] = ((encoded3 & 3) << 6) | (encoded4 & 63);
            }
        }
        return bytes.buffer;
    }

    async saveChapter(payload) {
        const { count, data } = payload;
        const chapterData = JSON.parse(data);

        const chapterIndex = chapterData.index;
        const chapterUri = `${this.baseUri}${this.currentBookDir}/content/${chapterIndex}.txt`;
        const state = this.chapterWriteState.get(chapterIndex) || {
            started: false,
            completed: false,
            lastChunkNum: -1,
            totalChunks: 0
        };

        if (state.completed && chapterData.chunkNum !== 0) {
            const overallProgress = (count + ((chapterData.chunkNum + 1) / chapterData.totalChunks)) / this.totalChapters;
            this.callback({ msg: "next", progress: overallProgress, filename: this.currentBookName });

            if (chapterData.chunkNum === chapterData.totalChunks - 1) {
                await this.send({ type: "chapter_chunk_complete" });
            } else {
                await this.send({ type: "next_chunk" });
            }
            return;
        }

        const isFirstChunk = chapterData.chunkNum === 0;
        const isLastChunk = chapterData.chunkNum === chapterData.totalChunks - 1;

        if (isFirstChunk) {
            state.started = true;
            state.completed = false;
            state.lastChunkNum = -1;
            state.totalChunks = chapterData.totalChunks;

            this.currentSavingChapterIndex = chapterIndex;

            try {
                await runAsyncFunc(file.delete, { uri: chapterUri });
            } catch (e) {}
        }

        const chunkText = chapterData.content || "";
        if (chunkText.length > 0) {
            const buffer = str2abWrite(chunkText);
            await runAsyncFunc(file.writeArrayBuffer, {
                uri: chapterUri,
                buffer,
                append: !isFirstChunk
            });
        } else if (isFirstChunk && isLastChunk) {
            await runAsyncFunc(file.writeText, {
                uri: chapterUri,
                text: " "
            });
        }

        state.lastChunkNum = chapterData.chunkNum;
        this.chapterWriteState.set(chapterIndex, state);

        const overallProgress = (count + ((chapterData.chunkNum + 1) / chapterData.totalChunks)) / this.totalChapters;
        this.callback({ msg: "next", progress: overallProgress, filename: this.currentBookName });

        if (isLastChunk) {
            state.completed = true;
            this.chapterWriteState.set(chapterIndex, state);

            this.currentChapterMeta = {
                index: chapterData.index,
                name: chapterData.name,
                wordCount: chapterData.wordCount
            };

            await this.send({ type: "chapter_chunk_complete" });

            if (count > 0 && count % 30 === 0) global.runGC();
        } else {
            await this.send({ type: "next_chunk" });
        }
    }

    async completeChapterTransfer({ count }) {
        if (this.currentChapterMeta) {
            this.pendingChapterMetas.push(this.currentChapterMeta);
            this.currentChapterMeta = null;
        }
        this.currentSavingChapterIndex = -1;

        this.syncedChapterIndices.add(count);
        this.receivedChapters = this.syncedChapterIndices.size;
        this.dirtyLindex = true;

        if (this.pendingChapterMetas.length >= this.BATCH_WRITE_SIZE || this.receivedChapters >= this.totalChapters) {
            await this.flushPendingChapterMetas();
        } else {
            await this.flushLindexIfNeeded(false);
        }

        await this.send({
            type: "chapter_saved",
            count: this.receivedChapters,
            syncedCount: this.receivedChapters,
            totalCount: this.totalChapters,
            progress: (this.receivedChapters / this.totalChapters) * 100
        });
    }

    async flushPendingChapterMetas() {
        if (this.flushingMetas) return;
        if (this.pendingChapterMetas.length === 0) {
            await this.flushLindexIfNeeded(false);
            return;
        }

        this.flushingMetas = true;
        try {
            const currentBookDir = this.currentBookDir;
            const metasToFlush = [...this.pendingChapterMetas];
            this.pendingChapterMetas = [];

            const metasByChunk = new Map();
            for (const meta of metasToFlush) {
                const chunkIndex = Math.floor(meta.index / this.CHAPTERS_PER_FILE) + 1;
                if (!metasByChunk.has(chunkIndex)) metasByChunk.set(chunkIndex, []);
                metasByChunk.get(chunkIndex).push(meta);
            }

            for (const [chunkIndex, metas] of metasByChunk) {
                const chunkUri = `${this.baseUri}${currentBookDir}/indexes/${chunkIndex}.txt`;

                let existingContent = "";
                try {
                    existingContent = (await runAsyncFunc(file.readText, { uri: chunkUri })).text;
                } catch (e) {}

                const existingMap = new Map();
                existingContent.split('\n').forEach(line => {
                    if (!line.trim()) return;
                    const parts = line.split('\t');
                    if (parts.length >= 1) {
                        const idx = parseInt(parts[0], 10);
                        if (!isNaN(idx)) existingMap.set(idx, line);
                    }
                });

                metas.forEach(meta => {
                    existingMap.set(meta.index, `${meta.index}\t${meta.name}\t${meta.wordCount || 0}`);
                });

                const newContent = Array.from(existingMap.keys())
                    .sort((a, b) => a - b)
                    .map(idx => existingMap.get(idx))
                    .join('\n') + '\n';

                await runAsyncFunc(file.writeText, { uri: chunkUri, text: newContent });
            }

            await this.flushLindexIfNeeded(true);
        } finally {
            this.flushingMetas = false;
        }
    }

    async flushLindexIfNeeded(force = false) {
        if (!this.lindexContent || !this.currentBookDir) return;

        const now = Date.now();
        if (!force) {
            if (!this.dirtyLindex) return;
            if (now - this.lastLindexFlushTime < this.LINDEX_FLUSH_INTERVAL) return;
        }

        const lindexUri = `${this.baseUri}${this.currentBookDir}/lindex.txt`;
        const lines = this.lindexContent.split('\n');
        lines[0] = this.totalChapters.toString();
        lines[1] = this.syncedChapterIndices.size.toString();
        const newLindexContent = lines.join('\n');

        this.lindexContent = newLindexContent;
        this.dirtyLindex = false;
        this.lastLindexFlushTime = now;

        await runAsyncFunc(file.writeText, { uri: lindexUri, text: newLindexContent });
    }

    async handleTransferComplete() {
        if (this.pendingChapterMetas.length > 0) {
            await this.flushPendingChapterMetas();
        } else {
            await this.flushLindexIfNeeded(true);
        }
        await this.clearCache();
        this.resetState();
        global.runGC();
        this.send({ type: "transfer_finished" });
        this.callback({ msg: "success" });
    }

    async getReadingData({ filename }) {
        try {
            const sanitizedDirName = this.generateDirName(filename);
            let progress = null;
            let readingTime = null;
            let bookmarks = [];

            try {
                const progressData = await bookStorage.get(sanitizedDirName);
                if (progressData) progress = JSON.stringify(progressData);
            } catch (e) {}

            try {
                let rtData = await readingTimeStorage.getReadingTime(sanitizedDirName);
                if (!rtData) rtData = await readingTimeStorage.getReadingTime(filename);
                if (rtData) readingTime = JSON.stringify(rtData);
            } catch (e) {}

            try {
                bookmarks = await bookStorage.getBookmarks(sanitizedDirName) || [];
            } catch (e) {}

            this.send({ type: "sync_reading_data", filename, progress, readingTime, bookmarks });
        } catch (error) {
            this.send({ type: "error", message: `获取阅读数据失败: ${error.message}`, count: 0 });
        }
    }

    async setReadingData({ filename, progress, readingTime, bookmarks }) {
        try {
            const sanitizedDirName = this.generateDirName(filename);

            if (progress) {
                await bookStorage.set(sanitizedDirName, JSON.parse(progress));
            }

            if (readingTime) {
                const allReadingTime = await readingTimeStorage.getAllBooksReadingTime();
                allReadingTime[sanitizedDirName] = JSON.parse(readingTime);
                await readingTimeStorage.saveReadingTime(allReadingTime);
            }

            if (bookmarks) {
                await bookStorage.setBookmarks(sanitizedDirName, bookmarks);
            }

            this.send({ type: "success", message: "同步成功", count: 0 });
        } catch (error) {
            this.send({ type: "error", message: `同步失败: ${error.message}`, count: 0 });
        }
    }

    async deleteChapters({ filename, chapterIndices }) {
        const sanitizedDirName = this.generateDirName(filename);
        let successCount = 0;
        const total = chapterIndices.length;

        for (let i = 0; i < total; i++) {
            try {
                await chapterManager.deleteChapter(sanitizedDirName, chapterIndices[i]);
                successCount++;
                this.send({ type: "progress", message: `正在删除 ${i + 1}/${total}`, count: Math.floor(((i + 1) / total) * 100) });
            } catch (error) {}
        }

        this.send({
            type: "success",
            message: `成功删除 ${successCount} 个章节`,
            count: successCount
        });
    }

    async deleteBook({ filename }) {
        try {
            const dirName = this.generateDirName(filename);
            const bookDirUri = `${this.baseUri}${dirName}`;

            try { await runAsyncFunc(file.rmdir, { uri: bookDirUri, recursive: true }); } catch (e) {}
            try { await bookStorage.removeBook(dirName); } catch (e) {}

            this.send({ type: "success", message: "删除成功", count: 0 });
        } catch (error) {
            this.send({ type: "error", message: `删除失败: ${error.message}`, count: 0 });
        }
    }

    async getStorageInfo() {
        try {
            const deviceInfo = await runAsyncFunc(device.getInfo);
            const totalData = await runAsyncFunc(device.getTotalStorage);
            const availData = await runAsyncFunc(device.getAvailableStorage);

            const storageInfo = calculateStorageInfo(
                totalData ? totalData.totalStorage : 0,
                availData ? availData.availableStorage : 0,
                deviceInfo ? deviceInfo.product : null
            );

            this.send({
                type: "storage_info",
                product: deviceInfo ? deviceInfo.product : null,
                ...storageInfo
            });
        } catch (error) {
            this.send({
                type: "storage_info",
                product: null,
                totalStorage: 0,
                availableStorage: 0,
                reservedStorage: 0,
                usedStorage: 0,
                actualAvailable: 0
            });
        }
    }

    async getSettings({ keys }) {
        try {
            const settings = {};
            for (const key of keys) {
                try {
                    await new Promise((resolve) => {
                        storage.get({
                            key: key,
                            success: (data) => {
                                settings[key] = data;
                                resolve();
                            },
                            fail: () => {
                                settings[key] = null;
                                resolve();
                            }
                        });
                    });
                } catch (e) {
                    settings[key] = null;
                }
            }
            this.send({ type: "settings_data", settings });
        } catch (error) {
            this.send({ type: "error", message: `获取设置失败: ${error.message}`, count: 0 });
        }
    }

    async setSettings({ settings }) {
        try {
            for (const key in settings) {
                if (settings.hasOwnProperty(key)) {
                    const value = settings[key];
                    await new Promise((resolve) => {
                        storage.set({
                            key: key,
                            value: value ? value.toString() : '',
                            success: resolve,
                            fail: resolve
                        });
                    });
                }
            }
            this.send({ type: "success", message: "设置已更新", count: 0 });
        } catch (error) {
            this.send({ type: "error", message: `更新设置失败: ${error.message}`, count: 0 });
        }
    }

    setCallback(callback) {
        this.callback = callback;
    }

    callback() {}
}
