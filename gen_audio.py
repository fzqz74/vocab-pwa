# -*- coding: utf-8 -*-
"""为词库所有单词生成 edge-tts 发音 mp3 -> audio/<word>.mp3"""
import asyncio, re, os, sys
import edge_tts

VOICE = 'en-US-GuyNeural'  # 男声
SEM = asyncio.Semaphore(30)

def extract_words(path):
    with open(path, encoding='utf-8') as f:
        return set(re.findall(r'word:"([^"]+)"', f.read()))

words = extract_words('js/words.js') | extract_words('js/words_full.js')
os.makedirs('audio', exist_ok=True)
todo = [w for w in sorted(words) if not os.path.exists('audio/%s.mp3' % w)]
print('total %d words, todo %d' % (len(words), len(todo)), flush=True)

done = 0
failed = []

async def gen(w):
    global done
    async with SEM:
        for attempt in range(3):
            try:
                c = edge_tts.Communicate(w, VOICE, rate='-10%')
                await c.save('audio/%s.mp3' % w)
                done += 1
                if done % 200 == 0:
                    print('progress %d/%d' % (done, len(todo)), flush=True)
                return
            except Exception as e:
                await asyncio.sleep(1 + attempt * 2)
        failed.append(w)

async def main():
    chunks = [todo[i:i+200] for i in range(0, len(todo), 200)]
    for ci, chunk in enumerate(chunks):
        await asyncio.gather(*[gen(w) for w in chunk])
        print('chunk %d/%d done' % (ci + 1, len(chunks)), flush=True)
    print('FAILED %d' % len(failed), flush=True)
    if failed:
        print('\n'.join(failed), flush=True)

asyncio.run(main())
