const PROMPT_TEXT = '点击查看插图';
const MARKER_REGEX = /\[\[SINE_IMG\|([^|\]]+)(?:\|([^|\]]*))?]]/g;

function decodeComponent(value) {
    try {
        return decodeURIComponent((value || '').replace(/\+/g, '%20'));
    } catch (e) {
        return value || '';
    }
}

function appendTextBlocks(target, text) {
    if (!text) return;
    text.split('\n')
        .map(line => line.replace(/\s+$/g, ''))
        .filter(line => line && line.trim())
        .forEach(line => target.push({ type: 'text', text: line }));
}

function stripIllustrationMarkers(content) {
    if (!content) return '';
    return content
        .replace(MARKER_REGEX, '\n\n')
        .replace(/\n{3,}/g, '\n\n');
}

function parseIllustrationBlocks(content, bookDirName, showIllustration = true) {
    const blocks = [];
    if (!content) return blocks;
    if (!showIllustration) {
        appendTextBlocks(blocks, stripIllustrationMarkers(content));
        return blocks;
    }

    let lastIndex = 0;
    content.replace(MARKER_REGEX, (match, encodedPath, encodedAlt, offset) => {
        if (offset > lastIndex) {
            appendTextBlocks(blocks, content.slice(lastIndex, offset));
        }

        const relativePath = decodeComponent(encodedPath);
        const altText = encodedAlt ? decodeComponent(encodedAlt) : '';
        if (relativePath) {
            blocks.push({
                type: 'illustration',
                text: PROMPT_TEXT,
                relativePath,
                altText,
                imageUri: `internal://files/books/${bookDirName}/${relativePath}`
            });
        }

        lastIndex = offset + match.length;
        return match;
    });

    if (lastIndex < content.length) {
        appendTextBlocks(blocks, content.slice(lastIndex));
    }

    return blocks;
}

function toDisplayText(content, showIllustration = true) {
    if (!content) return '';
    if (!showIllustration) return stripIllustrationMarkers(content);
    return content
        .replace(MARKER_REGEX, `\n\n${PROMPT_TEXT}\n\n`)
        .replace(/\n{3,}/g, '\n\n');
}

function extractIllustrationUris(content, bookDirName) {
    return parseIllustrationBlocks(content, bookDirName)
        .filter(block => block.type === 'illustration')
        .map(block => block.imageUri);
}

function findFirstIllustration(content, bookDirName, showIllustration = true) {
    if (!content || !showIllustration) return null;
    const regex = new RegExp(MARKER_REGEX);
    const match = regex.exec(content);
    if (!match) return null;

    const relativePath = decodeComponent(match[1]);
    if (!relativePath) return null;

    const altText = match[2] ? decodeComponent(match[2]) : '';
    return {
        startIndex: match.index,
        endIndex: match.index + match[0].length,
        rawLength: match[0].length,
        relativePath,
        altText,
        imageUri: `internal://files/books/${bookDirName}/${relativePath}`
    };
}

export default {
    PROMPT_TEXT,
    stripIllustrationMarkers,
    parseIllustrationBlocks,
    toDisplayText,
    extractIllustrationUris,
    findFirstIllustration
};
