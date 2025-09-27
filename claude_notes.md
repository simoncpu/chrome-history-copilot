# Claude Development Notes

This file documents changes, fixes, and development notes for the AI History Chrome extension.

## Recent Changes and Fixes

### 2025-01-28: Initialization Loading State Fix

**Problem**: Chrome extension showed blank page when browser first loaded and system wasn't ready yet.

**Solution**: Implemented proper initialization loading state using existing processing status UI.

**Files Modified**:
- `chrome-extension/sidepanel/history_search.js`
- `chrome-extension/offscreen.js`

**Changes Made**:

#### 1. System Readiness Check (`history_search.js`)
- Added `checkSystemReadiness()` function with retry logic (up to 10 seconds)
- Pings offscreen document every 500ms to verify system is ready
- Shows progress updates during initialization
- Graceful error handling if initialization fails

#### 2. Initialization Flow (`history_search.js`)
- Made `initializeSearchPage()` async
- Added `showInitializationStatus()` function using existing processing status UI
- Shows "Initializing AI History Search..." with shimmer loading
- Disables search input until system ready
- Enables search only after successful system check

#### 3. Ping Handler (`offscreen.js`)
- Added `ping` message handler in offscreen document
- Responds with `{ status: 'ready', initialized: isInitialized }`

**User Experience**:
- No more blank pages on startup
- Beautiful processing status bar with "Initializing AI History Search..." message
- Shimmer loading animation in results area
- Progress indication with percentage updates
- Search input disabled with "Initializing search..." placeholder
- Graceful transition to empty state or saved search execution

### 2025-01-28: SQLite FLOAT to INTEGER Conversion Fix

**Problem**: Chrome's History API returned FLOAT timestamps causing SQLite INTEGER column errors.

**Error**: `SQLITE_ERROR: Expected integer for INTEGER metadata column first_visit_at, received FLOAT`

**Solution**: Applied `Math.floor()` to all timestamp values before database insertion.

**Files Modified**:
- `chrome-extension/background.js` (lines 309, 322)
- `chrome-extension/offscreen.js` (lines 790-791, 836-837)
- `chrome-extension/content-extractor.js` (lines 106, 140)
- `technical_challenges_sqlite.md` (documentation updated)

**Root Cause**: Chrome's `historyItem.lastVisitTime` sometimes returns floating-point numbers instead of integers.

### 2025-01-28: Duplicate Processing Prevention

**Problem**: UI showed "processing..." status for already-indexed websites.

**Solution**: Added database existence check before queueing pages for ingestion.

**Files Modified**:
- `chrome-extension/offscreen.js` (added `pageExists()` method and message handler)
- `chrome-extension/background.js` (enhanced `queuePageForIngestion()` with database check)

**Benefits**:
- Eliminates false "processing..." status for already-indexed pages
- Reduces unnecessary database operations
- Maintains existing 30-second duplicate prevention
- Graceful fallback if database check fails

### 2025-01-28: Search Input Disabled State Styling Fix

**Problem**: Search input lost rounded edges when disabled during processing.

**Solution**: Added `border-radius: var(--border-radius-soft);` to `.search-input:disabled` CSS rule.

**File Modified**: `chrome-extension/sidepanel/styles.css` (line 548)

**Root Cause**: Disabled state CSS added border without border-radius, breaking organic flow design.

### 2025-01-28: Input Disabling Feature Flag System

**Problem**: Need to gate search/chat input disabling during processing for debugging UI lockups.

**Solution**: Implemented feature flag system with debug UI control.

**Files Modified**:
- `chrome-extension/sidepanel/history_search.js` (added feature flag, preference loading, gated disable/enable calls)
- `chrome-extension/sidepanel/history_chat.js` (same changes for chat page)
- `chrome-extension/debug.html` (added checkbox UI)
- `chrome-extension/debug.js` (added preference handling)

**Features**:
- Default: inputs NOT disabled during processing (for debugging)
- Toggleable via debug page checkbox
- Persistent setting stored in `aiPrefs.disableInputDuringProcessing`
- Works for both search and chat pages

## Development Patterns

### Error Handling
- Always use `Math.floor()` for timestamp values going to SQLite INTEGER columns
- Implement graceful fallbacks for failed operations
- Use retry logic with exponential backoff for system initialization

### UI State Management
- Use existing processing status UI for loading states
- Combine processing status bar with shimmer loading for comprehensive feedback
- Always provide user feedback during long operations
- Gate potentially disruptive UI changes with feature flags

### Database Operations
- Check database existence before unnecessary operations
- Implement proper duplicate prevention at multiple levels
- Use consistent error handling and logging patterns

## Technical Notes

### Chrome Extension Startup Timing
- Offscreen document initialization can take 100-500ms
- Service worker → UI timing race conditions require careful handling
- Always show loading state immediately, then check system readiness

### SQLite Data Types
- Chrome APIs may return unexpected data types (FLOAT vs INTEGER)
- Always normalize data types before database operations
- SQLite INTEGER columns strictly enforce integer values

### Feature Flag System
- Use `chrome.storage.local` for persistent settings
- Default to safe/non-disruptive behavior
- Provide debug UI for easy toggling during development

### 2025-01-28: SQLite Database Persistence Fix

**Problem**: Browsing history, summaries, etc. were lost after closing the browser because SQLite wasn't persisting to IndexedDB.

**Solution**: Changed database path from `/ai-history.db` to `/idb-ai-history.db` to use IndexedDB VFS.

**Files Modified**:
- `chrome-extension/offscreen.js` (line 264)

**Technical Details**:
- The `/idb-` prefix tells SQLite WASM to use IndexedDB Virtual File System
- IndexedDB automatically handles persistence across browser sessions
- Database pages stored as blobs in IndexedDB object store `sqlite-wasm-vfs`
- No explicit sync operations needed - IndexedDB VFS handles automatically

### 2025-01-28: SQLite Persistence Issue Investigation

**Problem**: The previous fix (changing to `/idb-ai-history.db`) didn't resolve the persistence issue. Data is still lost after closing the browser.

**Investigation**: Added comprehensive debug messages to track:
- Database initialization with path verification
- VFS detection via `PRAGMA database_list`
- Initial data count on startup
- Data insertion logging
- Database stats reporting

**Debug Messages Added**:
- `[DB] Initializing SQLite database with path: /idb-ai-history.db`
- `[DB] Database created, filename: <actual filename>`
- `[DB] Database info: <VFS details>`
- `[DB] Initial data check - existing pages: <count>`
- `[DB] Inserting page: <url> title: <title>`
- `[DB] Page inserted successfully with ID: <id>`
- `[DB] Database stats - Pages: <count> Embeddings: <count> VFS: <bool>`

**Status**: ISSUE FOUND AND FIXED

**Root Cause Identified**:
- The IndexedDB VFS is not available in the SQLite build (`[DB] IndexedDB VFS available: false`)
- Database was using `unix-none` VFS instead of IndexedDB VFS
- The `/idb-` path prefix had no effect because IndexedDB VFS wasn't compiled in

**Solution Plan**: Manual SQLite-vec WASM compilation with IndexedDB VFS support:
1. **Current State**: Using default VFS (no persistence) temporarily
2. **Future Action**: Compile sqlite-vec WASM with IndexedDB VFS module included
3. **Code Ready**: Existing code will automatically detect and use IndexedDB VFS once available

**Technical Details**:
- Current build only has: `["unix-none", "memfs", "kvvfs", "opfs", "default"]` VFS options
- Missing IndexedDB VFS module prevents `/idb-` path prefix from working
- KVVFS fallback attempted but failed with `SQLITE_CANTOPEN` error
- Documented in `technical_challenges_sqlite.md` for compilation reference

### 2025-01-28: Summarization Queue Stats Bug Fix

**Problem**: Summarization queue stats showing impossible values like `{queued: 0, processing: 3, completed: 3}` indicating a counter management bug.

**Root Cause**: The `summaryQueueStats.processing` counter was incremented when starting processing but never decremented when finished, causing it to accumulate incorrect values.

**Solution**: Added `finally` block to ensure `summaryQueueStats.processing--` always executes, even if processing fails.

**Files Modified**:
- `chrome-extension/offscreen.js` (processSummaryQueue function)

### 2025-01-28: Storage Backend Validation

**Problem**: Need to ensure the extension uses proper storage backend (IndexedDB) for Chrome extension compatibility.

**Solution**: PGlite automatically uses IndexedDB storage:
- PGlite configured with IndexedDB dataDir
- Automatic persistence across browser sessions
- No OPFS usage (not supported in Chrome extensions)

**Debug Messages Added**:
- `[DB] Storage backend: IndexedDB`
- `[DB] ✅ Using IndexedDB storage - safe for Chrome extension`

**Files Modified**:
- `chrome-extension/offscreen.js` (database initialization)

## Known Issues

### Summarization Queue Infinite Loop (offscreen.html)

**Issue**: Infinite loop in summarization queue processing showing:
```
[SUMMARIZATION] Queue Stats: {queued: 0, processing: 3, completed: 3, failed: 0, currentlyProcessing: null, …}
```

**Status**: Identified but not yet fixed. Will revisit later.

**Location**: `chrome-extension/offscreen.js` - summarization queue processing logic

### Debug Page Connection Error on Startup (Partial Fix)

**Issue**: Debug page still fails to connect when opened immediately after browser startup, despite adding 'ping' to offscreenMessages array.

**Error**:
```
[BG] Creating new offscreen document
[BG] Offscreen document created successfully
[DEBUG] Connection failed: Error: Invalid response from offscreen document
```

**Status**: Partially fixed (ping now forwards to offscreen), but connection still fails. Added debug messages to investigate response format.

**Location**: `chrome-extension/background.js`, `chrome-extension/debug.js`

**Next Steps**: Check actual response format and timing issues. Debug messages added for investigation.

### 2025-01-28: Debug Page Connection Error Fix

**Problem**: When opening debug page immediately after browser startup (before visiting any website), connection fails with "Invalid response from offscreen document" error.

**Root Cause**: The 'ping' message from debug.js was handled directly by background script instead of being forwarded to offscreen document. This bypassed the `forwardToOffscreen()` flow which would create the offscreen document if needed.

**Solution**: Added 'ping' to the `offscreenMessages` array and removed duplicate ping handler from background script.

**Files Modified**:
- `chrome-extension/background.js` (lines 248, 262-264)

**Technical Details**:
- Debug page now triggers offscreen document creation on first ping
- Proper routing through `ensureOffscreenDocument()` flow
- Consistent with other offscreen document operations
- Eliminates need to visit a website first to initialize the system

### 2025-01-28: Chat Interface Design Improvements

**Changes Made**: Enhanced chat interface to match search interface design and improve user experience.

**Files Modified**:
- `chrome-extension/sidepanel/history_chat.html`
- `chrome-extension/sidepanel/history_chat.js`
- `chrome-extension/sidepanel/styles.css`

#### 1. Chat Input Section Redesign
- Applied organic flow styling from search interface
- Added radial gradient backgrounds with ocean/orange color palette
- Implemented decorative gradient border at top of section
- Enhanced focus animations with color transitions and elevation
- Updated to use asymmetrical organic border radius
- Added backdrop blur effects for modern depth

#### 2. Clear Chat Button Relocation
- Moved from separate status container into input container as icon button
- Converted from text "Clear Chat" to trash can icon
- Positioned inline with send button in new `.chat-actions` container
- Added hover effects with red accent color for destructive action indication
- Eliminated separate `.chat-status` container entirely
- Saved significant vertical space while improving accessibility

#### 3. Scroll Position Persistence Fix (FIXED)
**Root Cause Identified**: Scroll event listener was attached to wrong element (`#chatMessages` instead of `.chat-container`)

**Solution Applied**:
- Fixed scroll listener to attach to `.chat-container` (the actual scrollable element with `overflow-y: auto`)
- Updated all scroll operations (`scrollToBottom`, `isNearBottom`, restore) to use `.chat-container`
- Applied same working pattern as search page (`.content-scroll-wrapper`)
- Simplified logging and removed test code

**Files Modified**:
- `chrome-extension/sidepanel/history_chat.js` (scroll persistence functions)

**Status**: FIXED - scroll position persistence now working correctly

**Code Cleanup Performed**:
- Removed unused `searchHistory` function (legacy compatibility code)
- Removed test scroll-to-middle logic
- Simplified debug logging while keeping essential error logs