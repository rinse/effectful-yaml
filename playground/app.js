import { evaluateYaml, highlightYaml, parse, stringify } from './effectful-yaml.js';

const exampleSelect = document.getElementById('example-select');
const runButton = document.getElementById('run-button');
const sourceInput = document.getElementById('source-input');
const inputInput = document.getElementById('launch-input');
const outputPane = document.getElementById('output-pane');
const logPane = document.getElementById('log-pane');
const errorPane = document.getElementById('error-pane');

const FALLBACK_NAME = 'fizzbuzz.yaml';
// fetch できない（file:// 直開き等）ときの最小限の既定文書。
const FALLBACK_SOURCE = '$let:\n  x: 1\n$in: ${x + 1}\n';

// textarea の文字は透明にしてあり、直前の <pre> に同じ文字列のハイライトを重ねて見せる。
function highlightEditor(textarea) {
  // 末尾が改行のとき <pre> にも最後の空行を描かせるため、改行を 1 つ足す。
  textarea.previousElementSibling.innerHTML = highlightYaml(textarea.value + '\n');
}

function setSource(text) {
  sourceInput.value = text;
  highlightEditor(sourceInput);
}

function showError(message) {
  errorPane.textContent = message;
  errorPane.hidden = false;
}

function clearError() {
  errorPane.hidden = true;
  errorPane.textContent = '';
}

async function loadExample(name) {
  const res = await fetch(`examples/${name}`);
  if (!res.ok) throw new Error(`failed to fetch examples/${name}`);
  return res.text();
}

async function initExamples() {
  try {
    const res = await fetch('examples/index.json');
    if (!res.ok) throw new Error('failed to fetch examples/index.json');
    const names = await res.json();
    for (const name of names) {
      const option = document.createElement('option');
      option.value = name;
      option.textContent = name;
      exampleSelect.append(option);
    }
    exampleSelect.value = names.includes(FALLBACK_NAME) ? FALLBACK_NAME : names[0];
    setSource(await loadExample(exampleSelect.value));
  } catch {
    setSource(FALLBACK_SOURCE);
  }
}

exampleSelect.addEventListener('change', async () => {
  try {
    setSource(await loadExample(exampleSelect.value));
  } catch (error) {
    showError(String(error?.message ?? error));
  }
});

async function run() {
  clearError();
  outputPane.textContent = '';
  logPane.textContent = '';

  let input;
  const inputText = inputInput.value.trim();
  if (inputText !== '') {
    let parsed;
    try {
      parsed = parse(inputText);
    } catch (error) {
      showError(`入力の YAML 解析に失敗しました: ${error?.message ?? error}`);
      return;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      showError('入力はオブジェクト（マッピング）である必要があります。');
      return;
    }
    input = parsed;
  }

  const logLines = [];
  try {
    const result = await evaluateYaml(sourceInput.value, {
      input,
      onLog: (value) => {
        logLines.push(typeof value === 'string' ? value : stringify(value).trimEnd());
        logPane.textContent = logLines.join('\n');
      },
    });
    outputPane.innerHTML = highlightYaml(stringify(result));
  } catch (error) {
    showError(error?.message ? error.message : String(error));
  }
}

for (const textarea of [sourceInput, inputInput]) {
  textarea.addEventListener('input', () => highlightEditor(textarea));
  highlightEditor(textarea);
}

runButton.addEventListener('click', run);
document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
    event.preventDefault();
    run();
  }
});

initExamples();
