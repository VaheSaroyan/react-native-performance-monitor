/*
 * Two behaviours, both of them answers to something the reader did:
 * copying a command, and scrolling. Nothing here animates on its own.
 */

/* --------------------------------------------------------------- copy */

/*
 * Only blocks tagged with a language get a copy button. The architecture
 * diagram is a picture made of box-drawing characters — a button offering to
 * put it on the clipboard would be noise.
 */
for (const block of document.querySelectorAll('.code[data-lang]')) {
  const source = block.querySelector('code');
  if (!source) continue;

  // Every tagged block gets a header strip: it names the language and gives the
  // button somewhere to sit that is not on top of the code.
  let head = block.querySelector('.code-head');
  if (!head) {
    head = document.createElement('div');
    head.className = 'code-head';
    head.textContent = block.dataset.lang;
    block.prepend(head);
  }

  const button = document.createElement('button');
  button.className = 'copy';
  button.type = 'button';
  button.textContent = 'Copy';
  button.setAttribute('aria-label', 'Copy to clipboard');

  button.addEventListener('click', async () => {
    // Shell prompts are typography, not part of the command. Comments are
    // kept: they explain what the line does once it is pasted somewhere else.
    const text = source.textContent
      .split('\n')
      .map((line) => line.replace(/^\$ /, ''))
      .join('\n')
      .trim();

    try {
      await navigator.clipboard.writeText(text);
      button.textContent = 'Copied';
    } catch {
      // Insecure origin, denied permission, or an old browser: say so rather
      // than claiming a copy that never happened.
      button.textContent = 'Select it';
      getSelection()?.selectAllChildren(source);
    }
    button.dataset.done = 'true';
    setTimeout(() => {
      button.textContent = 'Copy';
      delete button.dataset.done;
    }, 1600);
  });

  head.appendChild(button);
}

/* ----------------------------------------------------------- scrollspy */

const links = new Map();
for (const link of document.querySelectorAll('.rail a')) {
  links.set(link.hash.slice(1), link);
}

const sections = [...document.querySelectorAll('.doc > section[id]')];

if (sections.length && 'IntersectionObserver' in window) {
  const visible = new Set();

  const mark = () => {
    // With several sections on screen, the topmost wins: that is the one the
    // reader is reading down from, not the one just entering at the bottom.
    const current = sections.find((s) => visible.has(s.id))?.id;
    for (const [id, link] of links) {
      if (id === current) link.setAttribute('aria-current', 'true');
      else link.removeAttribute('aria-current');
    }
  };

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) visible.add(entry.target.id);
        else visible.delete(entry.target.id);
      }
      mark();
    },
    // Ignore the band under the sticky bar, and treat the lower two thirds of
    // the viewport as "not yet reading" so the highlight does not run ahead.
    { rootMargin: '-56px 0px -66% 0px' }
  );

  for (const section of sections) observer.observe(section);
}
