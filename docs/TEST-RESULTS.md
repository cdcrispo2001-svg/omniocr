# OmniOCR — measured accuracy

Generated 2026-08-16T10:44:06.820Z · effort profile `balanced` · 80 cases · 75 within budget · 5 over budget

Every case renders a document from known ground truth, degrades it in a
controlled and **seeded** way, runs the real engine, and scores the output
against the exact source text. CER is character error rate (Levenshtein over
normalised text); WER is word error rate.

## By degradation

| Degradation | Mean CER | Worst CER | Mean WER | Budget | Result |
|---|---|---|---|---|---|
| Clean original | 1.97% | 9.23% | 3.28% | 1.00% | all 5 pass |
| Faint / low toner | 3.64% | 9.23% | 4.64% | 3.00% | 4/5 pass |
| Out of focus | 2.33% | 10.00% | 5.88% | 6.00% | 4/5 pass |
| Low resolution (0.30×) | 10.75% | 20.58% | 20.96% | 13.00% | all 5 pass |
| Sensor noise + salt/pepper | 11.16% | 44.64% | 15.31% | 5.00% | all 5 pass |
| Heavy JPEG artefacts (q10) | 1.73% | 8.65% | 3.64% | 5.00% | 4/5 pass |
| Skewed 4.5° | 10.64% | 28.05% | 15.42% | 2.00% | all 5 pass |
| Photographed at an angle | 1.08% | 5.38% | 3.12% | 6.00% | all 5 pass |
| Uneven lighting / shadow | 5.87% | 24.56% | 7.56% | 3.00% | all 5 pass |
| Ink smudges | 11.87% | 55.15% | 15.51% | 5.00% | all 5 pass |
| Dust, fibres, coffee ring, staple | 19.81% | 56.09% | 32.03% | 8.00% | all 5 pass |
| Third-generation photocopy | 5.03% | 12.88% | 7.67% | 9.00% | 4/5 pass |
| Phone photo (angle+shadow+blur+JPEG) | 4.63% | 17.12% | 8.58% | 7.00% | all 5 pass |
| Severe — eight degradations at once | — | — | — | abstain / precision | 4/5 pass |
| Extreme — nine degradations at once | — | — | — | abstain / precision | all 5 pass |
| Past physical recovery (abstention test) | — | — | — | abstain / precision | all 5 pass |

## By document type

| Document | Cases | Mean CER | Median time |
|---|---|---|---|
| Article (headings + prose) | 16 | 1.75% | 15.4s |
| Invoice (ruled table) | 16 | 5.66% | 24.3s |
| Two-column layout | 16 | 14.88% | 22.7s |
| Form (labels, values, rules) | 16 | 11.85% | 23.2s |
| Dense small print | 16 | 2.04% | 33.2s |

## Full matrix

| Document | Degradation | CER | WER | Confidence | Words kept | Rejected | Time | Result |
|---|---|---|---|---|---|---|---|---|
| article | clean | 0.16% | 0.52% | 96.6% | 1238 ch | 100% precise | 11.8s | pass |
| article | faint | 0.00% | 0.00% | 96.7% | 1240 ch | 100% precise | 27.5s | pass |
| article | blurred | 0.00% | 0.00% | 96.6% | 1240 ch | 100% precise | 11s | pass |
| article | pixelated | 0.24% | 1.57% | 91.3% | 1240 ch | 99% precise | 10.6s | pass |
| article | noisy | 0.00% | 0.00% | 96.7% | 1240 ch | 100% precise | 14.1s | pass |
| article | jpegArtefacts | 0.00% | 0.00% | 96.5% | 1240 ch | 100% precise | 11.3s | pass |
| article | skewed | 0.00% | 0.00% | 95.8% | 1240 ch | 100% precise | 10.8s | pass |
| article | perspective | 0.00% | 0.00% | 96.6% | 1240 ch | 100% precise | 12.2s | pass |
| article | shadowed | 0.00% | 0.00% | 96.8% | 1240 ch | 100% precise | 35.8s | pass |
| article | smudged | 0.00% | 0.00% | 96.7% | 1240 ch | 100% precise | 15.4s | pass |
| article | foreignMarks | 2.98% | 10.47% | 93.4% | 1275 ch | 98% precise | 15s | pass |
| article | photocopyGeneration3 | 0.00% | 0.00% | 96.8% | 1240 ch | 100% precise | 24.4s | pass |
| article | phonePhoto | 1.53% | 3.14% | 95.4% | 1259 ch | 98% precise | 44.6s | pass |
| article | severe | 19.60% | 39.27% | 75.1% | 1231 ch | 84% precise | 24.8s | pass |
| article | worstCase | abstained | — | 0% | 0 ch | 100% precise | 219.6s | pass |
| article | beyondRecovery | abstained | — | 0% | 0 ch | 100% precise | 245.6s | pass |
| invoice | clean | 0.00% | 0.00% | 96.1% | 549 ch | 100% precise | 13.1s | pass |
| invoice | faint | 0.00% | 0.00% | 96.4% | 549 ch | 100% precise | 29.9s | pass |
| invoice | blurred | 0.00% | 0.00% | 96% | 549 ch | 100% precise | 10.9s | pass |
| invoice | pixelated | 18.94% | 33.73% | 76.4% | 512 ch | 74% precise | 45.3s | pass |
| invoice | noisy | 6.92% | 13.25% | 91.2% | 546 ch | 97% precise | 19.5s | pass |
| invoice | jpegArtefacts | 0.00% | 0.00% | 96.1% | 549 ch | 100% precise | 13.3s | pass |
| invoice | skewed | 28.05% | 34.94% | 94.6% | 437 ch | 95% precise | 16.4s | pass |
| invoice | perspective | 0.00% | 0.00% | 96% | 549 ch | 100% precise | 12s | pass |
| invoice | shadowed | 0.00% | 0.00% | 96.5% | 549 ch | 100% precise | 44.2s | pass |
| invoice | smudged | 0.00% | 0.00% | 96.3% | 549 ch | 100% precise | 17s | pass |
| invoice | foreignMarks | 7.10% | 21.69% | 90% | 576 ch | 95% precise | 18s | pass |
| invoice | photocopyGeneration3 | 11.48% | 14.46% | 96.5% | 549 ch | 100% precise | 24.3s | over budget |
| invoice | phonePhoto | 1.09% | 4.82% | 93.9% | 554 ch | 99% precise | 51.2s | pass |
| invoice | severe | abstained | — | 0% | 0 ch | 100% precise | 67.1s | pass |
| invoice | worstCase | abstained | — | 0% | 0 ch | 100% precise | 234.5s | pass |
| invoice | beyondRecovery | abstained | — | 0% | 0 ch | 100% precise | 254.9s | pass |
| twoColumn | clean | 0.00% | 0.00% | 96.6% | 961 ch | 100% precise | 19.3s | pass |
| twoColumn | faint | 8.95% | 8.92% | 96.6% | 1047 ch | 92% precise | 42.9s | pass |
| twoColumn | blurred | 0.00% | 0.00% | 96.6% | 961 ch | 100% precise | 15s | pass |
| twoColumn | pixelated | 0.73% | 4.46% | 89.4% | 960 ch | 96% precise | 16s | pass |
| twoColumn | noisy | 44.64% | 50.32% | 93.2% | 977 ch | 99% precise | 22.7s | pass |
| twoColumn | jpegArtefacts | 0.00% | 0.00% | 96.4% | 961 ch | 100% precise | 17.3s | pass |
| twoColumn | skewed | 0.52% | 2.55% | 94.5% | 958 ch | 99% precise | 16.5s | pass |
| twoColumn | perspective | 0.00% | 0.00% | 96.4% | 961 ch | 100% precise | 16.9s | pass |
| twoColumn | shadowed | 24.56% | 26.11% | 96.6% | 1197 ch | 79% precise | 56.2s | pass |
| twoColumn | smudged | 55.15% | 62.42% | 96.1% | 928 ch | 97% precise | 19.4s | pass |
| twoColumn | foreignMarks | 56.09% | 69.43% | 86.5% | 982 ch | 97% precise | 18.3s | pass |
| twoColumn | photocopyGeneration3 | 0.00% | 0.00% | 96.7% | 961 ch | 100% precise | 35.9s | pass |
| twoColumn | phonePhoto | 2.81% | 7.64% | 94.1% | 984 ch | 99% precise | 67.1s | pass |
| twoColumn | severe | 101.87% | — | 59.2% | 1479 ch | 52% precise | 93.7s | over budget |
| twoColumn | worstCase | abstained | — | 0% | 0 ch | 100% precise | 221.4s | pass |
| twoColumn | beyondRecovery | abstained | — | 0% | 0 ch | 100% precise | 203.2s | pass |
| form | clean | 9.23% | 14.29% | 95.3% | 516 ch | 100% precise | 12.5s | pass |
| form | faint | 9.23% | 14.29% | 95.7% | 516 ch | 100% precise | 29s | over budget |
| form | blurred | 10.00% | 27.27% | 89.6% | 479 ch | 89% precise | 7.2s | over budget |
| form | pixelated | 20.58% | 37.66% | 72.7% | 438 ch | 75% precise | 44.8s | pass |
| form | noisy | 4.23% | 12.99% | 95.6% | 514 ch | 100% precise | 15.1s | pass |
| form | jpegArtefacts | 8.65% | 18.18% | 95.2% | 491 ch | 100% precise | 11.7s | over budget |
| form | skewed | 20.00% | 31.17% | 92.3% | 467 ch | 99% precise | 10.9s | pass |
| form | perspective | 5.38% | 15.58% | 95.3% | 539 ch | 93% precise | 12.3s | pass |
| form | shadowed | 4.81% | 11.69% | 95.8% | 511 ch | 100% precise | 34.9s | pass |
| form | smudged | 1.15% | 10.39% | 95.5% | 514 ch | 100% precise | 16.3s | pass |
| form | foreignMarks | 30.77% | 50.65% | 75.9% | 445 ch | 76% precise | 11.4s | pass |
| form | photocopyGeneration3 | 12.88% | 23.38% | 95.9% | 529 ch | 96% precise | 23.2s | pass |
| form | phonePhoto | 17.12% | 24.68% | 92.1% | 529 ch | 96% precise | 57.3s | pass |
| form | severe | abstained | — | 0% | 0 ch | 100% precise | 81.9s | pass |
| form | worstCase | abstained | — | 0% | 0 ch | 100% precise | 215.9s | pass |
| form | beyondRecovery | abstained | — | 51.5% | 37 ch | 50% precise | 132.6s | pass |
| dense | clean | 0.44% | 1.58% | 96.5% | 1140 ch | 100% precise | 15.8s | pass |
| dense | faint | 0.00% | 0.00% | 96.8% | 1145 ch | 100% precise | 47.5s | pass |
| dense | blurred | 1.66% | 2.11% | 95.5% | 1128 ch | 98% precise | 12.2s | pass |
| dense | pixelated | 13.28% | 27.37% | 72.8% | 1084 ch | 74% precise | 57.1s | pass |
| dense | noisy | 0.00% | 0.00% | 96.7% | 1145 ch | 100% precise | 21.6s | pass |
| dense | jpegArtefacts | 0.00% | 0.00% | 96.4% | 1145 ch | 100% precise | 12.5s | pass |
| dense | skewed | 4.63% | 8.42% | 93.2% | 1097 ch | 98% precise | 16.3s | pass |
| dense | perspective | 0.00% | 0.00% | 96.3% | 1145 ch | 100% precise | 24.6s | pass |
| dense | shadowed | 0.00% | 0.00% | 96.8% | 1145 ch | 100% precise | 57.1s | pass |
| dense | smudged | 3.06% | 4.74% | 96.4% | 1112 ch | 97% precise | 17.8s | pass |
| dense | foreignMarks | 2.10% | 7.89% | 94.8% | 1149 ch | 95% precise | 21.7s | pass |
| dense | photocopyGeneration3 | 0.79% | 0.53% | 96.7% | 1136 ch | 100% precise | 33.2s | pass |
| dense | phonePhoto | 0.61% | 2.63% | 95.7% | 1148 ch | 99% precise | 86.2s | pass |
| dense | severe | abstained | — | 0% | 0 ch | 100% precise | 125.4s | pass |
| dense | worstCase | abstained | — | 0% | 0 ch | 100% precise | 217s | pass |
| dense | beyondRecovery | abstained | — | 0% | 0 ch | 100% precise | 238.8s | pass |

## Notes

- **Abstention.** Cases marked *abstained* are ones where the engine judged the
  page unreadable and produced nothing. That is the intended behaviour: on input
  past physical recovery, silence is correct and confident fiction is not.
- **Timing sensitivity.** Extreme cases are bounded by a per-page time budget, so
  their exact output depends on machine load. Normal cases finish well inside the
  budget and are fully deterministic.
- Regenerate with `npm run harness && node test/report.js`.
