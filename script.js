/* 状態管理 */
let appData = { folders: [] };
let authToken = localStorage.getItem('quizAuthToken'); // ★追加: トークンを記憶する変数
let currentFolderId = null;
let currentSetId = null;
let currentQuestions = [];
let currentIndex = 0;
let userAnswers = [];
let timerInterval = null;
let elapsedTime = 0;
let targetFolderIdForImport = null;
let currentFontScale = 1;

let syncFileHandle = null; 

/* --- IndexedDB ユーティリティ (ファイル場所の記憶) --- */
const DB_NAME = "QuizAppDB";
const STORE_NAME = "fileHandles";

function initDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME);
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function saveHandleToDB(handle) {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readwrite");
        const store = tx.objectStore(STORE_NAME);
        store.put(handle, "syncFileHandle");
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

async function getHandleFromDB() {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readonly");
        const store = tx.objectStore(STORE_NAME);
        const request = store.get("syncFileHandle");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function verifyPermission(fileHandle, readWrite) {
    const options = { mode: readWrite ? 'readwrite' : 'read' };
    if ((await fileHandle.queryPermission(options)) === 'granted') return true;
    if ((await fileHandle.requestPermission(options)) === 'granted') return true;
    return false;
}

/* ★追加：日付パースの安全装置（Safari等でのエラー回避） */
function parseSafeDate(dateStr) {
    if (!dateStr) return new Date();
    let d = new Date(dateStr);
    if (!isNaN(d)) return d;
    // YYYY/MM/DD 形式をハイフンに変換して再パース
    const fixedStr = dateStr.replace(/\//g, '-').replace(' ', 'T');
    d = new Date(fixedStr);
    if (!isNaN(d)) return d;
    return new Date();
}

function logout(){
    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', () => {
            if (confirm('ログアウトしますか？')) {
                localStorage.removeItem('quizAuthToken');
                authToken = null;
                appData = { folders: [] };
                location.reload();
            }
        });
    }
}

// 初期化フロー
async function initApp() {
    try {
        syncFileHandle = await getHandleFromDB();
        if (syncFileHandle) {
            const statusText = document.getElementById('sync-status');
            if(statusText) {
                statusText.textContent = "🔄 クリックして同期を再開";
                statusText.style.color = "#E67E22";
            }
            const syncBtn = document.getElementById('sync-file-btn');
            if(syncBtn) {
                syncBtn.textContent = "🔄 同期を再開する";
                syncBtn.classList.add('btn-warning');
            }
        }
    } catch(e) { console.log("DBハンドル取得失敗"); }

    loadAppData();
    initDarkMode();
    initFontSize();
    initSidebarToggle(); 
    renderHeatmap();
    logout()
}

initApp();

// --- データ管理 (Cloudflare KV & API) ---
async function loadAppData() {
    // トークンがなければログインモーダルを表示して終了
    if (!authToken) {
        const loginModal = document.getElementById('login-modal');
        if (loginModal) loginModal.style.display = 'flex';
        return;
    }

    try {
        const res = await fetch('/api/data', {
            headers: { 'Authorization': `Bearer ${authToken}` }
        });

        if (res.status === 401) {
            // 本当に認証が無効な場合のみログインを促す
            localStorage.removeItem('quizAuthToken');
            authToken = null;
            const loginModal = document.getElementById('login-modal');
            if (loginModal) loginModal.style.display = 'flex';
            return;
        }

        const text = await res.text();
        if (text && text.trim() !== '') {
            appData = JSON.parse(text);
            appData.folders.forEach(f => {
                f.sets.forEach(s => {
                    if (!s.history) s.history = [];
                    if (s.inProgress === undefined) s.inProgress = null;
                });
            });
        }
    } catch (e) {
        console.log("データ読み込みエラー", e);
    }

    cleanupOldHistory();
    renderSidebar();
    renderHeatmap();
}

function cleanupOldHistory() {
    const thresholdDate = new Date();
    thresholdDate.setDate(thresholdDate.getDate() - 90); 
    let isCleaned = false;

    appData.folders.forEach(f => {
        f.sets.forEach(s => {
            if(s.history) {
                s.history.forEach(h => {
                    const d = parseSafeDate(h.date); // ★修正：安全にパース
                    if (!isNaN(d) && d < thresholdDate && h.userAnswers) {
                        delete h.userAnswers; 
                        isCleaned = true;
                    }
                });
            }
        });
    });
    return isCleaned;
}

async function saveAppData() {
    renderSidebar();
    
    // クラウド（KV）へ保存
    if (authToken) {
        try {
            await fetch('/api/data', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${authToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(appData)
            });
        } catch (error) {
            console.error("クラウド保存エラー", error);
        }
    }
    
    // 既存のローカルファイル同期（File System API）の処理があれば維持
    if (syncFileHandle) {
        try {
            const hasPermission = await verifyPermission(syncFileHandle, true);
            if (hasPermission) {
                const writable = await syncFileHandle.createWritable();
                await writable.write(JSON.stringify(appData, null, 2));
                await writable.close();
            }
        } catch (error) {
            console.error("保存エラー", error);
        }
    }
}
// フォルダ設定・同期再開ボタンの処理
const syncBtn = document.getElementById('sync-file-btn');
if (syncBtn) {
    syncBtn.onclick = async () => {
        try {
            if (syncFileHandle) {
                const hasPermission = await verifyPermission(syncFileHandle, true);
                if (hasPermission) {
                    const statusText = document.getElementById('sync-status');
                    if(statusText) {
                        statusText.textContent = "✅ log/log.json (同期中)";
                        statusText.style.color = "";
                        statusText.classList.add('active');
                    }
                    syncBtn.textContent = "💾 ローカルファイルと同期";
                    syncBtn.classList.remove('btn-warning');
                    
                    const file = await syncFileHandle.getFile();
                    const text = await file.text();
                    if (text.trim() !== '') {
                        appData = JSON.parse(text);
                        cleanupOldHistory();
                        localStorage.setItem('quizAppData_v2', JSON.stringify(appData));
                        renderSidebar();
                        renderHeatmap();
                    }
                    alert("同期を再開しました！");
                    return; 
                } else {
                    syncFileHandle = null;
                }
            }

            alert("現在のアプリがあるフォルダを選択してください。\n自動で「log」フォルダを作成し保存します。");
            const dirHandle = await window.showDirectoryPicker();
            const logDirHandle = await dirHandle.getDirectoryHandle('log', { create: true });
            syncFileHandle = await logDirHandle.getFileHandle('log.json', { create: true });
            
            await saveHandleToDB(syncFileHandle);
            
            const file = await syncFileHandle.getFile();
            const text = await file.text();
            
            if (text.trim() !== '') {
                appData = JSON.parse(text);
                cleanupOldHistory(); 
                localStorage.setItem('quizAppData_v2', JSON.stringify(appData));
                renderSidebar();
                renderHeatmap();
                alert("log.json からデータを読み込みました！");
            } else {
                saveAppData();
                alert("log/log.json を新規作成しました！");
            }
            const statusText = document.getElementById('sync-status');
            if(statusText) {
                statusText.textContent = "✅ log/log.json (同期中)";
                statusText.style.color = "";
                statusText.classList.add('active');
            }
            syncBtn.textContent = "💾 ローカルファイルと同期";
            syncBtn.classList.remove('btn-warning');
            
        } catch (e) { console.log("キャンセル", e); }
    };
}

/* =========================================
   画面遷移時の安全装置（クリーンアップ）
   ========================================= */
function cleanupAndSaveCurrent() {
    if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
    }
    if (currentSetId) {
        const set = appData.folders.find(f => f.id === currentFolderId)?.sets.find(s => s.id === currentSetId);
        if(set && currentQuestions.length === set.questions.length) {
            set.inProgress = { currentIndex, userAnswers, elapsedTime, currentQuestions };
            saveAppData();
        }
    }
    currentFolderId = null;
    currentSetId = null;
    currentQuestions = [];
    userAnswers = [];
    currentIndex = 0;
    elapsedTime = 0;
}

/* --- UI描画 (サイドバー) --- */
function renderSidebar() {
    const categoryNav = document.getElementById('category-nav');
    if(!categoryNav) return;
    categoryNav.innerHTML = ''; 
    
    appData.folders.forEach(folder => {
        if (folder.isOpen === undefined) folder.isOpen = false;

        const folderDiv = document.createElement('div');
        folderDiv.className = 'folder' + (folder.isOpen ? ' open' : '');
        
        const folderHeader = document.createElement('div');
        folderHeader.className = 'folder-header';
        
        folderHeader.onclick = () => {
            folder.isOpen = !folder.isOpen;
            saveAppData(); 
        };

        const titleDiv = document.createElement('div');
        titleDiv.className = 'folder-title';
        titleDiv.innerHTML = `<span class="folder-toggle-icon">▶</span> ${folder.name}`;
        
        const folderActions = document.createElement('div');
        folderActions.className = 'folder-actions';
        
        const addBtn = document.createElement('button');
        addBtn.className = 'icon-btn'; addBtn.textContent = '＋JSON';
        addBtn.onclick = (e) => {
            e.stopPropagation(); 
            targetFolderIdForImport = folder.id; 
            document.getElementById('json-file-input').click(); 
        };

        const delBtn = document.createElement('button');
        delBtn.className = 'icon-btn'; delBtn.textContent = '🗑️';
        delBtn.onclick = (e) => {
            e.stopPropagation(); 
            if (confirm('フォルダを削除しますか？')) {
                appData.folders = appData.folders.filter(f => f.id !== folder.id);
                saveAppData();
            }
        };

        folderActions.append(addBtn, delBtn);
        folderHeader.append(titleDiv, folderActions);
        folderDiv.appendChild(folderHeader);

        const setContainer = document.createElement('div');
        setContainer.className = 'folder-sets-container';
        if (!folder.isOpen) setContainer.style.display = 'none';

        folder.sets.forEach(set => {
            const setWrapper = document.createElement('div');
            setWrapper.className = 'set-wrapper';

            const setBtn = document.createElement('button');
            setBtn.className = 'set-btn';
            
            const progressMark = set.inProgress ? ' ⏱️(途中)' : '';
            setBtn.textContent = set.name + progressMark;
            setBtn.onclick = () => {
                closeMobileMenu(); 
                if (currentSetId === set.id) return;
                cleanupAndSaveCurrent();
                initQuizSequence(folder.id, set.id);
            };
            
            const btnGroup = document.createElement('div');
            btnGroup.className = 'set-btn-group';

            const reportBtn = document.createElement('button');
            reportBtn.className = 'icon-btn'; 
            reportBtn.textContent = '📊';
            reportBtn.title = '最新のレポートを見る';
            reportBtn.onclick = (e) => {
                e.stopPropagation();
                showReport(folder.id, set.id); 
            };

            const delSetBtn = document.createElement('button');
            delSetBtn.className = 'icon-btn'; delSetBtn.textContent = '✖';
            delSetBtn.style.color = '#FF7675';
            delSetBtn.onclick = (e) => {
                e.stopPropagation();
                if(confirm('セットを削除しますか？')) {
                    folder.sets = folder.sets.filter(s => s.id !== set.id);
                    saveAppData();
                }
            };

            btnGroup.append(reportBtn, delSetBtn);
            setWrapper.append(setBtn, btnGroup);
            setContainer.appendChild(setWrapper);
        });
        
        folderDiv.appendChild(setContainer);
        categoryNav.appendChild(folderDiv);
    });
}

const addFolderBtn = document.getElementById('add-folder-btn');
if(addFolderBtn) {
    addFolderBtn.onclick = () => {
        const name = prompt('フォルダ名:');
        if (name) {
            appData.folders.push({ id: 'f_' + Date.now(), name, sets: [], isOpen: true });
            saveAppData();
        }
    };
}

const jsonInput = document.getElementById('json-file-input');
if(jsonInput) {
    jsonInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
            try {
                const jsonData = JSON.parse(ev.target.result);
                if (!Array.isArray(jsonData) || !jsonData[0]["問題文"]) throw new Error();
                
                const folder = appData.folders.find(f => f.id === targetFolderIdForImport);
                const newSetName = file.name.replace('.json', '');
                
                const existingSetIndex = folder.sets.findIndex(s => s.name === newSetName);
                
                if (existingSetIndex !== -1) {
                    if (confirm(`「${newSetName}」は既に存在します。\n最新のJSONデータで問題を上書き更新しますか？\n（キャンセルで破棄します。上書きしても学習履歴は保持されます）`)) {
                        folder.sets[existingSetIndex].questions = jsonData;
                        saveAppData();
                        alert('問題を上書き更新しました。');
                    }
                } else {
                    folder.sets.push({
                        id: 's_' + Date.now(),
                        name: newSetName,
                        questions: jsonData,
                        history: [],
                        inProgress: null
                    });
                    folder.isOpen = true;
                    saveAppData();
                    alert('ロードしました。');
                }
            } catch { alert("JSONフォーマットが不正です"); }
            e.target.value = '';
        };
        reader.readAsText(file);
    });
}

/* --- クイズ実行ロジック --- */
function initQuizSequence(folderId, setId) {
    currentFolderId = folderId;
    currentSetId = setId;
    const folder = appData.folders.find(f => f.id === folderId);
    const set = folder.sets.find(s => s.id === setId);

    if (set.inProgress) {
        document.getElementById('resume-modal').classList.remove('hidden');
    } else {
        startFreshQuiz(set.questions);
    }
}

function shuffleArray(array) {
    const arr = [...array];
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

function startFreshQuiz(questionsData) {
    const set = appData.folders.find(f => f.id === currentFolderId).sets.find(s => s.id === currentSetId);
    
    const chk = document.getElementById('shuffle-mode-chk');
    const isShuffle = chk ? chk.checked : false;
    currentQuestions = isShuffle ? shuffleArray(questionsData) : [...questionsData];
    
    currentIndex = 0;
    userAnswers = [];
    elapsedTime = 0;
    
    if (questionsData.length === set.questions.length) {
        set.inProgress = { currentIndex, userAnswers, elapsedTime, currentQuestions }; 
        saveAppData();
    }
    
    document.getElementById('quiz-title').textContent = set.name + (isShuffle ? " (🔀シャッフル)" : "");
    startTimer();
    switchScreen('quiz-screen');
    renderQuestion();
}

const retestBtn = document.getElementById('retest-btn');
if(retestBtn) {
    retestBtn.onclick = () => {
        const incorrectQuestions = currentQuestions.filter((q, i) => {
            return userAnswers[i] && !userAnswers[i].isCorrect;
        });
        if (incorrectQuestions.length > 0) {
            cleanupAndSaveCurrent(); 
            currentQuestions = incorrectQuestions;
            currentIndex = 0;
            userAnswers = [];
            elapsedTime = 0;
            
            document.getElementById('quiz-title').textContent += " 【⚠️再テスト】";
            startTimer();
            switchScreen('quiz-screen');
            renderQuestion();
        }
    };
}

document.getElementById('resume-btn').onclick = () => {
    document.getElementById('resume-modal').classList.add('hidden');
    resumeQuiz();
};

document.getElementById('restart-btn').onclick = () => {
    document.getElementById('resume-modal').classList.add('hidden');
    const set = appData.folders.find(f => f.id === currentFolderId).sets.find(s => s.id === currentSetId);
    startFreshQuiz(set.questions);
};

document.getElementById('cancel-modal-btn').onclick = () => {
    document.getElementById('resume-modal').classList.add('hidden');
    cleanupAndSaveCurrent(); 
    renderHeatmap();
    switchScreen('welcome-screen');
};

function resumeQuiz() {
    const set = appData.folders.find(f => f.id === currentFolderId).sets.find(s => s.id === currentSetId);
    currentQuestions = set.inProgress.currentQuestions || set.questions;
    currentIndex = set.inProgress.currentIndex;
    userAnswers = set.inProgress.userAnswers || [];
    elapsedTime = set.inProgress.elapsedTime || 0;
    
    document.getElementById('quiz-title').textContent = set.name;
    startTimer();
    switchScreen('quiz-screen');
    renderQuestion();
}

function startTimer() {
    if(timerInterval) clearInterval(timerInterval);
    timerInterval = setInterval(() => {
        elapsedTime++;
        updateTimerDisplay();
        saveCurrentProgress();
    }, 1000);
}

function updateTimerDisplay() {
    const h = Math.floor(elapsedTime / 3600);
    const m = Math.floor((elapsedTime % 3600) / 60);
    const s = elapsedTime % 60;
    const timeStr = h > 0 ? `${h}:${m.toString().padStart(2,'0')}:${s.toString().padStart(2,'0')}` 
                          : `${m.toString().padStart(2,'0')}:${s.toString().padStart(2,'0')}`;
    const display = document.getElementById('timer-display');
    if(display) display.textContent = `⏱ ${timeStr}`;
}

function saveCurrentProgress() {
    if (!currentSetId) return;
    const set = appData.folders.find(f => f.id === currentFolderId)?.sets.find(s => s.id === currentSetId);
    if(set && currentQuestions.length === set.questions.length) {
        set.inProgress = { currentIndex, userAnswers, elapsedTime, currentQuestions };
        saveAppData();
    }
}

function renderQuestion() {
    if (!currentQuestions || currentQuestions.length === 0) return;
    const q = currentQuestions[currentIndex];
    
    document.getElementById('current-q-num').textContent = currentIndex + 1;
    document.getElementById('total-q-num').textContent = currentQuestions.length;
    document.getElementById('question-text').textContent = q["問題文"];
    
    const choicesGrid = document.getElementById('choices-grid');
    choicesGrid.innerHTML = ''; 
    
    const zenkakuNum = ["１", "２", "３", "４", "５", "６", "７", "８", "９"];
    const choices = [];
    zenkakuNum.forEach(num => {
        if (q[`選択肢${num}`]) choices.push(q[`選択肢${num}`]);
    });
    
    const isMultiple = Array.isArray(q["正解"]);
    let currentSelections = []; 

    let submitBtn = document.getElementById('submit-answer-btn');
    if (!submitBtn) {
        submitBtn = document.createElement('button');
        submitBtn.id = 'submit-answer-btn';
        submitBtn.className = 'btn primary-btn';
        submitBtn.style.display = 'block';
        submitBtn.style.margin = '0 auto 20px auto';
        submitBtn.textContent = '解答を確定する';
        choicesGrid.parentNode.insertBefore(submitBtn, document.getElementById('feedback-area'));
    }
    
    submitBtn.style.display = isMultiple ? 'block' : 'none'; 
    submitBtn.disabled = true;
    
    choices.forEach((choiceText, index) => {
        const btn = document.createElement('button');
        btn.className = 'choice-btn';
        btn.textContent = `${index + 1}. ${choiceText}`;
        btn.dataset.index = index + 1; 
        
        let pressTimer;
        const toggleEliminate = (e) => {
            e.preventDefault(); 
            if (btn.classList.contains('selected')) return; 
            btn.classList.toggle('eliminated');
        };

        btn.addEventListener('contextmenu', toggleEliminate);
        btn.addEventListener('touchstart', (e) => {
            pressTimer = setTimeout(() => { toggleEliminate(e); }, 500);
        }, { passive: false });
        btn.addEventListener('touchend', () => clearTimeout(pressTimer));
        btn.addEventListener('touchmove', () => clearTimeout(pressTimer));

        btn.onclick = () => {
            if (btn.classList.contains('eliminated')) return;

            if (isMultiple) {
                const val = index + 1;
                if (currentSelections.includes(val)) {
                    currentSelections = currentSelections.filter(v => v !== val);
                    btn.classList.remove('selected');
                } else {
                    currentSelections.push(val);
                    btn.classList.add('selected');
                }
                submitBtn.disabled = currentSelections.length === 0;
            } else {
                handleAnswer([index + 1], [btn]);
            }
        };
        choicesGrid.appendChild(btn);
    });

    submitBtn.onclick = () => {
        if (isMultiple && currentSelections.length > 0) {
            const selectedBtns = Array.from(choicesGrid.children).filter(b => currentSelections.includes(parseInt(b.dataset.index)));
            handleAnswer(currentSelections, selectedBtns);
            submitBtn.style.display = 'none';
        }
    };

    document.getElementById('feedback-area').classList.add('hidden');
    document.getElementById('next-btn').style.display = 'none';
}

function handleAnswer(selectedIndices, clickedBtns) {
    const q = currentQuestions[currentIndex];
    
    const isMultiple = Array.isArray(q["正解"]);
    const correctAnswers = isMultiple ? [...q["正解"]].sort() : [q["正解"]];
    const userAnswersSorted = [...selectedIndices].sort();
    
    const isCorrect = JSON.stringify(correctAnswers) === JSON.stringify(userAnswersSorted);
    
    userAnswers[currentIndex] = { selectedIndices: userAnswersSorted, isCorrect };
    saveCurrentProgress();

    const allBtns = document.querySelectorAll('.choice-btn');
    const badge = document.getElementById('judgement-badge');
    const feedbackArea = document.getElementById('feedback-area');
    
    if (isCorrect) {
        badge.textContent = '〇 正解';
        badge.className = 'badge correct';
    } else {
        badge.textContent = '✕ 不正解';
        badge.className = 'badge incorrect';
    }

    allBtns.forEach(btn => {
        btn.disabled = true;
        btn.classList.remove('selected'); 
        
        const btnIndex = parseInt(btn.dataset.index);
        const isUserSelected = userAnswersSorted.includes(btnIndex);
        const isActuallyCorrect = correctAnswers.includes(btnIndex);

        if (isUserSelected) btn.textContent = "✓ " + btn.textContent;

        if (isActuallyCorrect) {
            btn.classList.add('correct');
        } else if (isUserSelected && !isActuallyCorrect) {
            btn.classList.add('incorrect', 'shake');
        }
    });

    document.getElementById('explanation-text').textContent = q["回答文"];
    feedbackArea.classList.remove('hidden');
    document.getElementById('next-btn').style.display = 'inline-block';
}

document.getElementById('next-btn').onclick = () => {
    currentIndex++;
    if (currentIndex < currentQuestions.length) {
        saveCurrentProgress();
        renderQuestion();
    } else {
        finishQuiz();
    }
};

/* --- 終了・結果画面 --- */
function finishQuiz() {
    if(timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
    }
    const set = appData.folders.find(f => f.id === currentFolderId).sets.find(s => s.id === currentSetId);
    
    const correctCount = userAnswers.filter(a => a && a.isCorrect).length;
    const total = currentQuestions.length;
    
    const isFullTest = (total === set.questions.length);

    // ★修正：再テストも含め、すべての完了を履歴（ヒートマップ用）に保存する
    const historyRecord = {
        date: new Date().toLocaleString('ja-JP'),
        elapsedTime: elapsedTime,
        correctCount: correctCount,
        total: total,
        isFullTest: isFullTest, // 再テストかどうかの判別用フラグ
        userAnswers: [...userAnswers] 
    };
    set.history.push(historyRecord);
    set.inProgress = null;
    
    cleanupOldHistory(); 
    saveAppData();

    document.getElementById('result-set-title').textContent = set.name;

    // 何回目のフルテストか（または再テストか）を表示
    const fullTestCount = set.history.filter(h => h.isFullTest !== false).length;
    document.getElementById('attempt-count').textContent = isFullTest ? `${fullTestCount}回目の試み` : `⚠️ 再テストの記録`;
    
    const h = Math.floor(elapsedTime / 3600);
    const m = Math.floor((elapsedTime % 3600) / 60);
    let timeText = h > 0 ? `${h}時間 ${m}分` : `${m}分`;
    if(elapsedTime < 60) timeText = `${elapsedTime}秒`;
    
    document.getElementById('result-total-info').textContent = `${total}問 | ${timeText}`;
    document.getElementById('result-date').textContent = historyRecord.date;

    const percent = Math.round((correctCount / total) * 100);
    document.getElementById('score-percent-val').textContent = percent;
    document.getElementById('score-fraction-val').textContent = `正解 (${correctCount}/${total})`;
    
    document.getElementById('result-chart').style.setProperty('--p', `${percent}%`);

    if(retestBtn) {
        if (correctCount < total) retestBtn.classList.remove('hidden');
        else retestBtn.classList.add('hidden');
    }

    const reviewBtn = document.getElementById('review-btn');
    if (reviewBtn) reviewBtn.style.display = 'inline-block';

    switchScreen('result-screen');
}

document.getElementById('home-btn').onclick = () => {
    cleanupAndSaveCurrent(); 
    renderHeatmap();
    switchScreen('welcome-screen');
}

/* --- 振り返り機能 --- */
document.getElementById('review-btn').onclick = () => {
    renderReview('all');
    switchScreen('review-screen');
};

document.getElementById('back-to-result-btn').onclick = () => switchScreen('result-screen');

const filterBtns = document.querySelectorAll('.filter-btn');
filterBtns.forEach(btn => {
    btn.onclick = (e) => {
        filterBtns.forEach(b => b.classList.remove('active'));
        e.target.classList.add('active');
        renderReview(e.target.dataset.filter);
    };
});

function renderReview(filterMode) {
    const listEl = document.getElementById('review-list');
    listEl.innerHTML = '';

    currentQuestions.forEach((q, i) => {
        const ans = userAnswers[i];
        if (!ans) return;

        if (filterMode === 'correct' && !ans.isCorrect) return;
        if (filterMode === 'incorrect' && ans.isCorrect) return;

        const item = document.createElement('div');
        item.className = `review-item ${ans.isCorrect ? 'correct' : 'incorrect'}`;

        const qText = document.createElement('div');
        qText.className = 'review-q';
        qText.textContent = `Q${i + 1}. ${q["問題文"]}`;

        const choicesGrid = document.createElement('div');
        choicesGrid.className = 'choices-grid review-choices';
        
        const zenkakuNum = ["１", "２", "３", "４", "５", "６", "７", "８", "９"];
        const choices = [];
        zenkakuNum.forEach(num => {
            if (q[`選択肢${num}`]) choices.push(q[`選択肢${num}`]);
        });
        
        const isMultiple = Array.isArray(q["正解"]);
        const correctAnswers = isMultiple ? q["正解"] : [q["正解"]];
        const userSelections = ans.selectedIndices || (ans.selectedIndex ? [ans.selectedIndex] : []);

        choices.forEach((choiceText, index) => {
            const btnIndex = index + 1;
            const choiceDiv = document.createElement('div');
            choiceDiv.className = 'choice-btn review-choice';
            
            const isUserSelected = userSelections.includes(btnIndex);
            const isActuallyCorrect = correctAnswers.includes(btnIndex);
            
            const prefix = isUserSelected ? "✓ " : "";
            choiceDiv.textContent = `${prefix}${btnIndex}. ${choiceText}`;

            if (isActuallyCorrect) {
                choiceDiv.classList.add('correct');
            } else if (isUserSelected && !isActuallyCorrect) {
                choiceDiv.classList.add('incorrect');
            }
            
            choicesGrid.appendChild(choiceDiv);
        });

        const expText = document.createElement('div');
        expText.className = 'review-exp';
        const expLabel = document.createElement('strong');
        expLabel.textContent = '【解説】\n';
        expText.appendChild(expLabel);
        expText.appendChild(document.createTextNode(q["回答文"]));

        item.append(qText, choicesGrid, expText);
        listEl.appendChild(item);
    });
}

function switchScreen(screenId) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(screenId).classList.add('active');
}

/* --- UIトグル・表示制御系 --- */
function initDarkMode() {
    const darkBtn = document.getElementById('dark-mode-btn');
    if(!darkBtn) return;
    const isDark = localStorage.getItem('darkMode') === 'true';
    if (isDark) {
        document.body.classList.add('dark-mode');
        darkBtn.textContent = '☀️ ライトモード';
    }
    darkBtn.onclick = () => {
        document.body.classList.toggle('dark-mode');
        const currentlyDark = document.body.classList.contains('dark-mode');
        localStorage.setItem('darkMode', currentlyDark);
        darkBtn.textContent = currentlyDark ? '☀️ ライトモード' : '🌙 ダークモード';
    };
}

const mobileMenuBtn = document.getElementById('mobile-menu-btn');
const sidebar = document.getElementById('sidebar');
const mobileOverlay = document.getElementById('mobile-overlay');

if(mobileMenuBtn) {
    mobileMenuBtn.onclick = () => {
        sidebar.classList.add('open');
        mobileOverlay.classList.remove('hidden');
    };
}

function closeMobileMenu() {
    if(sidebar) sidebar.classList.remove('open');
    if(mobileOverlay) mobileOverlay.classList.add('hidden');
}
if(mobileOverlay) mobileOverlay.onclick = closeMobileMenu;

function initFontSize() {
    const savedScale = localStorage.getItem('quizFontScale');
    if (savedScale) currentFontScale = parseFloat(savedScale);
    updateFontScaleUI();
    const incBtn = document.getElementById('font-inc-btn');
    const decBtn = document.getElementById('font-dec-btn');
    if(incBtn) {
        incBtn.onclick = () => {
            if (currentFontScale < 1.5) currentFontScale += 0.1;
            updateFontScaleUI();
        };
    }
    if(decBtn) {
        decBtn.onclick = () => {
            if (currentFontScale > 0.7) currentFontScale -= 0.1;
            updateFontScaleUI();
        };
    }
}
function updateFontScaleUI() {
    document.documentElement.style.setProperty('--font-scale', currentFontScale);
    localStorage.setItem('quizFontScale', currentFontScale);
}

function initSidebarToggle() {
    const toggleBtn = document.getElementById('sidebar-toggle-btn');
    const sidebarEl = document.getElementById('sidebar');
    if(!toggleBtn || !sidebarEl) return;

    const isCollapsed = localStorage.getItem('sidebarCollapsed') === 'true';
    if (isCollapsed) {
        sidebarEl.classList.add('collapsed');
        toggleBtn.textContent = '▶';
    }
    
    toggleBtn.onclick = () => {
        sidebarEl.classList.toggle('collapsed');
        const collapsed = sidebarEl.classList.contains('collapsed');
        toggleBtn.textContent = collapsed ? '▶' : '◀';
        localStorage.setItem('sidebarCollapsed', collapsed);
    };
}

function showReport(folderId, setId) {
    const folder = appData.folders.find(f => f.id === folderId);
    const set = folder.sets.find(s => s.id === setId);
    
    if (!set.history || set.history.length === 0) {
        alert("まだこのセットのテスト履歴がありません。\n1回以上最後まで解き終わるとレポートが生成されます。");
        return;
    }
    
    cleanupAndSaveCurrent();
    
    // ★修正：レポートには「通常のフルテスト」または「再テスト」の最新のものが表示されます
    const latestHistory = set.history[set.history.length - 1];
    
    currentFolderId = folderId;
    currentSetId = setId;
    currentQuestions = set.questions; 
    userAnswers = latestHistory.userAnswers || []; 
    
    const correctCount = latestHistory.correctCount;
    const total = latestHistory.total;
    const elapsedTime = latestHistory.elapsedTime;
    
    const fullTestCount = set.history.filter(h => h.isFullTest !== false).length;
    document.getElementById('result-set-title').textContent = set.name;
    document.getElementById('attempt-count').textContent = latestHistory.isFullTest === false 
        ? `過去のレポート (再テスト)` 
        : `過去のレポート (${fullTestCount}回目の試み)`;
    
    const h = Math.floor(elapsedTime / 3600);
    const m = Math.floor((elapsedTime % 3600) / 60);
    let timeText = h > 0 ? `${h}時間 ${m}分` : `${m}分`;
    if(elapsedTime < 60) timeText = `${elapsedTime}秒`;
    
    document.getElementById('result-total-info').textContent = `${total}問 | ${timeText}`;
    document.getElementById('result-date').textContent = latestHistory.date;

    const percent = Math.round((correctCount / total) * 100);
    document.getElementById('score-percent-val').textContent = percent;
    document.getElementById('score-fraction-val').textContent = `正解 (${correctCount}/${total})`;
    document.getElementById('result-chart').style.setProperty('--p', `${percent}%`);

    if(retestBtn) retestBtn.classList.add('hidden');

    const reviewBtn = document.getElementById('review-btn');
    if (reviewBtn) {
        reviewBtn.style.display = (userAnswers.length > 0) ? 'inline-block' : 'none';
    }
    
    switchScreen('result-screen');
}

/* =========================================
   学習ヒートマップ表示 
   ========================================= */
function updateHeatmapFilterOptions() {
    const select = document.getElementById('heatmap-filter');
    if(!select) return;
    const currentValue = select.value;
    select.innerHTML = '<option value="all">全体ビュー</option>';
    appData.folders.forEach(f => {
        const opt = document.createElement('option');
        opt.value = f.id;
        opt.textContent = `📁 ${f.name}`;
        select.appendChild(opt);
    });
    select.value = currentValue || 'all';
}

function updateHeatmapYearOptions(countsByDate) {
    const yearSelect = document.getElementById('heatmap-year');
    if(!yearSelect) return;
    
    const years = new Set();
    const currentYear = new Date().getFullYear();
    years.add(currentYear); 

    Object.keys(countsByDate).forEach(dateStr => {
        const y = parseInt(dateStr.split('-')[0]);
        if(!isNaN(y)) years.add(y);
    });

    const sortedYears = Array.from(years).sort((a, b) => b - a); 
    const currentValue = yearSelect.value || currentYear.toString();
    
    yearSelect.innerHTML = '';
    sortedYears.forEach(y => {
        const opt = document.createElement('option');
        opt.value = y;
        opt.textContent = `${y}年`;
        yearSelect.appendChild(opt);
    });
    
    if (sortedYears.includes(parseInt(currentValue))) {
        yearSelect.value = currentValue;
    } else {
        yearSelect.value = currentYear.toString();
    }
}

const heatmapFilter = document.getElementById('heatmap-filter');
if(heatmapFilter) heatmapFilter.addEventListener('change', renderHeatmap);

const heatmapYear = document.getElementById('heatmap-year');
if(heatmapYear) heatmapYear.addEventListener('change', renderHeatmap);

function renderHeatmap() {
    updateHeatmapFilterOptions();
    
    const filterSelect = document.getElementById('heatmap-filter');
    const filterFolderId = filterSelect ? filterSelect.value : 'all';
    
    const countsByDate = {};
    appData.folders.forEach(f => {
        if (filterFolderId !== 'all' && f.id !== filterFolderId) return;
        f.sets.forEach(s => {
            s.history.forEach(h => {
                const d = parseSafeDate(h.date); // ★修正：安全にパース
                if (!isNaN(d)) {
                    const dateKey = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
                    countsByDate[dateKey] = (countsByDate[dateKey] || 0) + h.total;
                }
            });
        });
    });

    updateHeatmapYearOptions(countsByDate);

    const yearSelect = document.getElementById('heatmap-year');
    const selectedYear = yearSelect ? parseInt(yearSelect.value) : new Date().getFullYear();

    const grid = document.getElementById('heatmap-grid');
    const xAxis = document.getElementById('heatmap-x-axis');
    if(!grid || !xAxis) return;

    grid.innerHTML = '';
    xAxis.innerHTML = '';
    
    const firstDayOfYear = new Date(selectedYear, 0, 1);
    const startDate = new Date(firstDayOfYear);
    startDate.setDate(firstDayOfYear.getDate() - firstDayOfYear.getDay());

    const lastDayOfYear = new Date(selectedYear, 11, 31);
    const endDate = new Date(lastDayOfYear);
    endDate.setDate(lastDayOfYear.getDate() + (6 - lastDayOfYear.getDay()));

    const timeDiff = endDate.getTime() - startDate.getTime();
    const totalDays = Math.floor(timeDiff / (1000 * 3600 * 24)) + 1;

    for (let i = 0; i < totalDays; i++) {
        const d = new Date(startDate);
        d.setDate(startDate.getDate() + i);
        
        const isCurrentYear = d.getFullYear() === selectedYear;
        const dateKey = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
        const count = countsByDate[dateKey] || 0;
        
        if (d.getDate() === 1 && isCurrentYear) {
            const colIndex = Math.floor(i / 7);
            const label = document.createElement('span');
            label.className = 'month-label';
            label.textContent = `${d.getMonth() + 1}月`;
            label.style.left = `${colIndex * 13}px`;
            xAxis.appendChild(label);
        }

        const square = document.createElement('div');
        
        if (!isCurrentYear) {
            square.className = 'day-square';
            square.style.visibility = 'hidden';
        } else {
            let level = 0;
            if (count > 0 && count <= 5) level = 1;
            else if (count >= 6 && count <= 15) level = 2;
            else if (count >= 16 && count <= 30) level = 3;
            else if (count > 30) level = 4;

            square.className = `day-square level-${level}`;
            const weekStr = ["日", "月", "火", "水", "木", "金", "土"][d.getDay()];
            square.dataset.title = `${d.getMonth()+1}月${d.getDate()}日(${weekStr}): ${count}問解答`;
        }
        grid.appendChild(square);
    }
}

/* =========================================
   手動バックアップ（ダウンロード・復元）
   ========================================= */
const downloadBtn = document.getElementById('download-backup-btn');
if (downloadBtn) {
    downloadBtn.onclick = () => {
        const dataStr = JSON.stringify(appData, null, 2);
        const blob = new Blob([dataStr], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const d = new Date();
        const dateStr = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
        const fileName = `quiz_backup_${dateStr}.json`;
        
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    };
}

const restoreBtn = document.getElementById('restore-backup-btn');
const restoreInput = document.getElementById('restore-file-input');
if (restoreBtn && restoreInput) {
    restoreBtn.onclick = () => {
        if (confirm("⚠️ 注意：現在のデータは全て上書き（消去）されます。\n\nよろしいですか？")) {
            restoreInput.click();
        }
    };
    restoreInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
            try {
                const jsonData = JSON.parse(ev.target.result);
                if (jsonData && Array.isArray(jsonData.folders)) {
                    cleanupAndSaveCurrent(); 
                    
                    appData = jsonData; 
                    cleanupOldHistory(); 
                    
                    localStorage.setItem('quizAppData_v2', JSON.stringify(appData));
                    renderSidebar();
                    renderHeatmap();
                    saveAppData();
                    
                    if (syncFileHandle) saveAppData();
                    alert('✅ バックアップからの復元が完了しました！');
                    switchScreen('welcome-screen');
                } else {
                    throw new Error("Invalid format");
                }
            } catch (err) {
                alert("❌ ファイルの形式が正しくありません。\n当アプリでダウンロードしたバックアップJSONを選択してください。");
            }
            e.target.value = ''; 
        };
        reader.readAsText(file);
    });
}

/* =========================================
   タイトルクリックでホーム画面へ戻る
   ========================================= */
const sidebarHeaderTitle = document.querySelector('.sidebar-header h2');
if (sidebarHeaderTitle) {
    sidebarHeaderTitle.style.cursor = 'pointer';
    sidebarHeaderTitle.title = "ホーム画面に戻る";
    
    sidebarHeaderTitle.addEventListener('mouseenter', () => sidebarHeaderTitle.style.opacity = '0.7');
    sidebarHeaderTitle.addEventListener('mouseleave', () => sidebarHeaderTitle.style.opacity = '1');
    
    sidebarHeaderTitle.addEventListener('click', () => {
        cleanupAndSaveCurrent();
        renderHeatmap();
        switchScreen('welcome-screen');
        closeMobileMenu();
    });
}


async function handleLogin(e) {
    e.preventDefault();
    const username = document.getElementById('login-username').value;
    const password = document.getElementById('login-password').value;

    try {
        const res = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        const result = await res.json();
        if (res.ok && result.token) {
            authToken = result.token;
            localStorage.setItem('quizAuthToken', authToken);
            document.getElementById('login-modal').style.display = 'none';
            loadAppData(); // ログイン成功後にデータをロード
        } else {
            alert(result.error || 'ログインに失敗しました');
        }
    } catch (err) {
        alert('通信エラーが発生しました');
    }
}

// ログインモーダル用のフォーム送信処理
async function handleLogin(e) {
    e.preventDefault();
    const username = document.getElementById('login-username').value;
    const password = document.getElementById('login-password').value;

    try {
        const res = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        const result = await res.json();
        if (res.ok && result.token) {
            authToken = result.token;
            localStorage.setItem('quizAuthToken', authToken);
            document.getElementById('login-modal').style.display = 'none';
            loadAppData(); // ログイン後にクラウドからデータをロード
        } else {
            alert(result.error || 'ログインに失敗しました');
        }
    } catch (err) {
        alert('通信エラーが発生しました');
    }
}
