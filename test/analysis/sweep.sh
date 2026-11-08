#!/bin/bash
# name and --set json per line
cd /home/jev/projects/pi/pi-context-guard-jev
while IFS='|' read -r name set; do
  node test/analysis/jev-replay.ts --offline --cache /tmp/cg-replay/cache.jsonl --out /tmp/cg-replay/sweep-$name.jsonl --set "$set" $(cat "${SESSIONS:-/tmp/cg-replay/all.txt}") 2>&1 | tail -1 | sed "s/^/$name: /" &
done <<'LIST'
default|{}
chunk50|{"chunkKeepThreshold":0.5,"midRunChunkKeepThreshold":0.5}
chunk40|{"chunkKeepThreshold":0.4,"midRunChunkKeepThreshold":0.4}
chunk70|{"chunkKeepThreshold":0.7,"midRunChunkKeepThreshold":0.7}
whole80|{"keepWholeThreshold":0.8,"focusWholeThreshold":0.7}
whole90|{"keepWholeThreshold":0.9,"focusWholeThreshold":0.8}
ratio80|{"maxKeepRatio":0.8}
small30|{"smallKeepThreshold":0.3}
small60|{"smallKeepThreshold":0.6}
ex35|{"exchangeOmitThreshold":0.35}
ex50|{"exchangeOmitThreshold":0.5}
none35|{"noneThreshold":0.35}
LIST
wait
