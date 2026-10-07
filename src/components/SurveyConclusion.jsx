import PollChart from './PollChart.jsx'
import { scaleCounts, scalePoints } from '../lib/survey'
import { scaleSummary, overallIndex } from '../lib/stats'
import { useI18n } from '../lib/i18n.js'
import { isMultiSelect, optionCounts } from '../lib/multiAnswer'

// The screen a survey ends on, in place of a quiz's podium: what the room
// said as a whole, and then question by question.
//
// Scale questions carry numbers, so they get the full summary - mean,
// median, most frequent answer and spread - over their distribution. A
// choice question has no numeric value, so averaging it would be
// meaningless: it gets its distribution and the answer that led.
export default function SurveyConclusion({ questions, answers, participants }) {
  const { t } = useI18n()

  const perQuestion = questions.map((q) => {
    const mine = answers.filter((a) => a.question_id === q.id)
    if (q.qtype === 'scale') {
      const points = scalePoints(q.meta)
      const counts = scaleCounts(mine, q.meta)
      // a question whose range never made it into the row has nothing to
      // summarise; better an empty note than a screen full of NaN
      const summary = points.length > 1
        ? scaleSummary(counts, points[0], points[points.length - 1])
        : null
      return { q, points, counts, summary }
    }
    const options = q.options || []
    const counts = optionCounts(mine, options.length)
    return { q, options, counts, answered: mine.length }
  })

  const scaled = perQuestion.filter((row) => row.q.qtype === 'scale')
  const overall = overallIndex(scaled.map((row) => row.summary))
  const answeredTotal = perQuestion.reduce((sum, row) => sum + (row.summary?.n ?? row.answered ?? 0), 0)

  const fmt = (value, digits = 1) =>
    value == null ? '—' : Number(value).toFixed(digits).replace(/\.0$/, '')

  return (
    <div className="survey-conclusion">
      <div className="survey-headline">
        {overall != null && (
          <div className="survey-stat big">
            <span className="survey-stat-value">{Math.round(overall)}</span>
            <span className="survey-stat-label">{t('מדד כולל (0-100)')}</span>
          </div>
        )}
        <div className="survey-stat">
          <span className="survey-stat-value">{participants}</span>
          <span className="survey-stat-label">{t('משתתפים')}</span>
        </div>
        <div className="survey-stat">
          <span className="survey-stat-value">{questions.length}</span>
          <span className="survey-stat-label">{t('שאלות')}</span>
        </div>
        <div className="survey-stat">
          <span className="survey-stat-value">{answeredTotal}</span>
          <span className="survey-stat-label">{t('תשובות')}</span>
        </div>
      </div>

      {overall != null && (
        <p className="survey-note muted small">
          {t('המדד הכולל הוא ממוצע המיקום על הסולם של שאלות הסולם, כשכל שאלה מתורגמת ל-0-100 ונספרת במשקל שווה.')}
        </p>
      )}

      <div className="survey-questions">
        {perQuestion.map((row, i) => (
          <div className="survey-question" style={{ '--i': i }} key={row.q.id}>
            <h3 className="survey-question-title">
              <span className="survey-question-num">{i + 1}</span>
              {row.q.text}
            </h3>

            {row.q.qtype === 'scale' ? (
              row.summary ? (
                <>
                  <div className="survey-metrics">
                    <div className="metric"><span>{fmt(row.summary.mean, 2)}</span><small>{t('ממוצע')}</small></div>
                    <div className="metric"><span>{fmt(row.summary.median)}</span><small>{t('חציון')}</small></div>
                    <div className="metric"><span>{row.summary.modes.join(', ')}</span><small>{t('השכיח')}</small></div>
                    <div className="metric"><span>{fmt(row.summary.sd, 2)}</span><small>{t('סטיית תקן')}</small></div>
                    <div className="metric"><span>{Math.round(row.summary.index)}</span><small>{t('מדד 0-100')}</small></div>
                    <div className="metric"><span>{row.summary.n}</span><small>{t('עונים')}</small></div>
                  </div>
                  <PollChart options={row.points.map(String)} counts={row.counts} scale />
                  <div className="survey-scale-ends muted small">
                    <span>{row.q.meta?.low_label}</span>
                    <span>{row.q.meta?.high_label}</span>
                  </div>
                </>
              ) : (
                <p className="muted">{t('לא התקבלו תשובות לשאלה זו.')}</p>
              )
            ) : row.answered ? (
              <>
                <div className="survey-metrics">
                  <div className="metric wide">
                    <span>{row.options[row.counts.indexOf(Math.max(...row.counts))]}</span>
                    <small>{t('הנבחרת ביותר')}</small>
                  </div>
                  <div className="metric"><span>{row.answered}</span><small>{t('עונים')}</small></div>
                </div>
                <PollChart
                  options={row.options}
                  counts={row.counts}
                  reference={false}
                  respondents={isMultiSelect(row.q) ? row.answered : null}
                />
              </>
            ) : (
              <p className="muted">{t('לא התקבלו תשובות לשאלה זו.')}</p>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
