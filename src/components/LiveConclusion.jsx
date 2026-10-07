import PollChart from './PollChart.jsx'
import { optionColor, optionLabel } from '../lib/optionStyle'
import { correctShare, averageRate } from '../lib/stats'
import { LIVE_BAR_TYPES, ANSWER_SLIDE_TYPES } from '../lib/quizMode'
import { useI18n } from '../lib/i18n.js'
import { isMultiSelect, optionCounts } from '../lib/multiAnswer'

// The screen a live quiz ends on, in place of a podium: how the room did as
// a whole, then question by question. Answers are counted, never ranked, so
// nothing here names or orders the participants.
//
// The headline correct rate averages the true/false and multiple-choice
// questions with equal weight, however many people answered each; a
// question nobody answered is left out rather than counted as 0%.
export default function LiveConclusion({ questions, answers, participants }) {
  const { t } = useI18n()

  const byQuestion = new Map()
  answers.forEach((a) => {
    const list = byQuestion.get(a.question_id)
    if (list) list.push(a)
    else byQuestion.set(a.question_id, [a])
  })

  const rows = questions
    .map((q, index) => ({ q, number: index + 1 }))
    .filter(({ q }) => LIVE_BAR_TYPES.includes(q.qtype))
    .map(({ q, number }) => {
      const mine = byQuestion.get(q.id) || []
      const options = q.options || []
      const counts = optionCounts(mine, options.length)
      const judged = ANSWER_SLIDE_TYPES.includes(q.qtype)
      return {
        q,
        number,
        counts,
        judged,
        share: judged ? correctShare(counts, q.correct_index) : null,
        answered: mine.length,
        labels: options.map((_, i) => optionLabel(q, i, t)),
        colors: options.map((_, i) => optionColor(q, i)),
      }
    })

  const average = averageRate(rows.map((row) => row.share))

  return (
    <div className="live-conclusion">
      <div className="live-headline">
        <div className="live-stat" style={{ '--i': 0 }}>
          <span className="live-stat-value">{participants}</span>
          <span className="live-stat-label">{t('משתתפים')}</span>
        </div>
        <div className="live-stat" style={{ '--i': 1 }}>
          <span className="live-stat-value">{questions.length}</span>
          <span className="live-stat-label">{t('שאלות')}</span>
        </div>
        {average != null && (
          <div className="live-stat big" style={{ '--i': 2 }}>
            <span className="live-stat-value">{Math.round(average * 100)}%</span>
            <span className="live-stat-label">{t('ממוצע תשובות נכונות')}</span>
          </div>
        )}
      </div>

      <div className="live-questions">
        {rows.map((row, i) => (
          <div
            className={`live-question${row.q.options?.length > 4 ? ' many' : ''}`}
            style={{ '--i': i }}
            key={row.q.id}
          >
            <h3 className="live-question-title">
              <span className="live-question-num">{row.number}</span>
              {row.q.text}
            </h3>
            {row.answered ? (
              <>
                {row.share && (
                  <p className="live-question-share">
                    <strong>{t('{percent}% ענו נכון', { percent: row.share.percent })}</strong>
                    <span>{t('{correct} מתוך {total} משתתפים', { correct: row.share.correct, total: row.share.total })}</span>
                  </p>
                )}
                <PollChart
                  options={row.labels}
                  counts={row.counts}
                  correctIndex={row.judged ? row.q.correct_index : null}
                  colorIndexes={row.colors}
                  reference={false}
                  respondents={isMultiSelect(row.q) ? row.answered : null}
                />
              </>
            ) : (
              <p className="live-question-empty">{t('לא התקבלו תשובות לשאלה זו.')}</p>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
