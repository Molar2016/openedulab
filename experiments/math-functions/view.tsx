import { useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_COEFFICIENTS,
  VIEW,
  describeFunction,
  formatNumber,
  samplePoints,
  type Coefficients,
  type FunctionModel,
  type ModelWarning,
} from './model';
import {
  interactionBucketFor,
  type ControlGroup,
  type ExperimentProps,
} from '../../apps/web/src/experiment/contract';
import manifest from './manifest.json';
import en from './locales/en.json';
import zhCN from './locales/zh-CN.json';

const dictionaries: Record<string, Record<string, string>> = {
  en: en as Record<string, string>,
  'zh-CN': zhCN as Record<string, string>,
};

const PLOT = { width: 640, height: 420, left: 48, right: 18, top: 20, bottom: 40 };
const GRAPH_ID = 'math-functions-graph-title';

function translate(locale: string, key: string): string {
  return dictionaries[locale]?.[key] ?? dictionaries.en[key] ?? key;
}

function toSvgX(x: number): number {
  const innerWidth = PLOT.width - PLOT.left - PLOT.right;
  return PLOT.left + ((x - VIEW.xMin) / (VIEW.xMax - VIEW.xMin)) * innerWidth;
}

function toSvgY(y: number): number {
  const innerHeight = PLOT.height - PLOT.top - PLOT.bottom;
  const clamped = Math.max(VIEW.yMin - 2, Math.min(VIEW.yMax + 2, y));
  return PLOT.top + ((VIEW.yMax - clamped) / (VIEW.yMax - VIEW.yMin)) * innerHeight;
}

function pathFor(model: FunctionModel): string {
  return samplePoints(model)
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${toSvgX(point.x).toFixed(2)},${toSvgY(point.y).toFixed(2)}`)
    .join(' ');
}

function inView(axis: 'x' | 'y', value: number): boolean {
  return axis === 'x'
    ? value >= VIEW.xMin && value <= VIEW.xMax
    : value >= VIEW.yMin && value <= VIEW.yMax;
}

interface GraphProps {
  model: FunctionModel;
  formula: string;
  locale: string;
}

function FunctionGraph({ model, formula, locale }: GraphProps): JSX.Element {
  const ticks = Array.from({ length: 11 }, (_, index) => index - 5).map((value) => value * 2);
  const curvePath = pathFor(model);

  return (
    <svg
      className="graph"
      viewBox={`0 0 ${PLOT.width} ${PLOT.height}`}
      role="img"
      aria-labelledby={GRAPH_ID}
      data-testid="function-graph"
    >
      <title id={GRAPH_ID}>{`${translate(locale, 'readout.formula')}: ${formula}`}</title>
      <defs>
        <clipPath id="plot-area">
          <rect
            x={PLOT.left}
            y={PLOT.top}
            width={PLOT.width - PLOT.left - PLOT.right}
            height={PLOT.height - PLOT.top - PLOT.bottom}
          />
        </clipPath>
      </defs>

      <rect
        className="graph__background"
        x={PLOT.left}
        y={PLOT.top}
        width={PLOT.width - PLOT.left - PLOT.right}
        height={PLOT.height - PLOT.top - PLOT.bottom}
        rx={6}
      />

      <g className="graph__grid" aria-hidden="true">
        {ticks.map((value) => (
          <line key={`vx-${value}`} x1={toSvgX(value)} y1={PLOT.top} x2={toSvgX(value)} y2={PLOT.height - PLOT.bottom} />
        ))}
        {ticks.map((value) => (
          <line key={`hy-${value}`} x1={PLOT.left} y1={toSvgY(value)} x2={PLOT.width - PLOT.right} y2={toSvgY(value)} />
        ))}
      </g>

      <g className="graph__axes" aria-hidden="true">
        <line x1={PLOT.left} y1={toSvgY(0)} x2={PLOT.width - PLOT.right} y2={toSvgY(0)} />
        <line x1={toSvgX(0)} y1={PLOT.top} x2={toSvgX(0)} y2={PLOT.height - PLOT.bottom} />
        {ticks.map((value) => (
          <text key={`tx-${value}`} x={toSvgX(value)} y={toSvgY(0) + 18} textAnchor="middle">
            {value}
          </text>
        ))}
        {ticks
          .filter((value) => value !== 0)
          .map((value) => (
            <text key={`ty-${value}`} x={toSvgX(0) - 8} y={toSvgY(value) + 4} textAnchor="end">
              {value}
            </text>
          ))}
        <text className="graph__axis-label" x={PLOT.width - PLOT.right} y={toSvgY(0) - 8} textAnchor="end">
          {translate(locale, 'graph.xAxis')}
        </text>
        <text className="graph__axis-label" x={toSvgX(0) + 8} y={PLOT.top + 12}>
          {translate(locale, 'graph.yAxis')}
        </text>
      </g>

      <path className="graph__curve" d={curvePath} clipPath="url(#plot-area)" data-testid="function-curve" />

      <g clipPath="url(#plot-area)">
        {model.vertex && inView('x', model.vertex.x) && inView('y', model.vertex.y) ? (
          <g className="marker marker--vertex" data-testid="vertex-marker">
            <circle cx={toSvgX(model.vertex.x)} cy={toSvgY(model.vertex.y)} r={6} />
            <text x={toSvgX(model.vertex.x) + 10} y={toSvgY(model.vertex.y) - 8}>
              {translate(locale, 'marker.vertex')}
            </text>
          </g>
        ) : null}

        {model.roots
          .filter((root) => inView('x', root) && inView('y', 0))
          .map((root, index) => (
            <g className="marker marker--root" key={`root-${index}`} data-testid="root-marker">
              <circle cx={toSvgX(root)} cy={toSvgY(0)} r={5} />
              <text x={toSvgX(root)} y={toSvgY(0) - 10} textAnchor="middle">
                {formatNumber(root)}
              </text>
            </g>
          ))}

        {inView('y', model.yIntercept) ? (
          <g className="marker marker--intercept" data-testid="intercept-marker">
            <circle cx={toSvgX(0)} cy={toSvgY(model.yIntercept)} r={4} />
          </g>
        ) : null}
      </g>

      <text className="graph__formula" x={PLOT.left + 8} y={PLOT.top + 24} data-testid="graph-formula">
        {formula}
      </text>
    </svg>
  );
}

interface ControlProps {
  id: string;
  label: string;
  value: number;
  disabled?: boolean;
  onChange: (value: number) => void;
}

function CoefficientControl({ id, label, value, disabled, onChange }: ControlProps): JSX.Element {
  return (
    <div className={`control${disabled ? ' control--disabled' : ''}`}>
      <label htmlFor={id}>{label}</label>
      <div className="control__row">
        <input
          id={id}
          type="range"
          min={-10}
          max={10}
          step={0.1}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(Number(event.target.value))}
        />
        <output htmlFor={id} className="control__value" data-testid={`value-${id}`}>
          {formatNumber(value)}
        </output>
      </div>
    </div>
  );
}

function warningText(warning: ModelWarning, locale: string): string {
  return translate(locale, `warning.${warning}`);
}

export default function MathFunctionsExperiment({ locale, resetToken, services }: ExperimentProps): JSX.Element {
  const [coefficients, setCoefficients] = useState<Coefficients>({ ...DEFAULT_COEFFICIENTS });
  const [completed, setCompleted] = useState(false);
  const interactCount = useRef(0);
  const lastReset = useRef(resetToken);

  const t = (key: string): string => translate(locale, key);

  useEffect(() => {
    if (resetToken === lastReset.current) return;
    lastReset.current = resetToken;
    setCoefficients({ ...DEFAULT_COEFFICIENTS });
    setCompleted(false);
    interactCount.current = 0;
  }, [resetToken]);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const { model, modelError } = useMemo(() => {
    try {
      return { model: describeFunction(coefficients), modelError: null as unknown };
    } catch (error) {
      return { model: null, modelError: error };
    }
  }, [coefficients]);

  useEffect(() => {
    if (modelError) services.errors.report({ code: 'model_error', error: modelError });
  }, [modelError, services]);

  const trackInteraction = (controlGroup: ControlGroup): void => {
    interactCount.current += 1;
    services.analytics.track({
      type: 'experiment_interact',
      experimentId: manifest.id,
      moduleVersion: manifest.moduleVersion,
      locale,
      controlGroup,
      interactionBucket: interactionBucketFor(interactCount.current),
    });
  };

  const updateCoefficient = (field: 'a' | 'b' | 'c', value: number): void => {
    setCoefficients((previous) => ({ ...previous, [field]: value }));
    trackInteraction(field);
  };

  const changeMode = (mode: Coefficients['mode']): void => {
    setCoefficients((previous) => ({ ...previous, mode }));
    trackInteraction('mode');
  };

  if (!model) {
    return (
      <div className="experiment-error" role="alert">
        <p>{t('meta.formulaHeading')}</p>
        <p>{String(modelError)}</p>
      </div>
    );
  }

  const vertexText = model.vertex
    ? `(${formatNumber(model.vertex.x)}, ${formatNumber(model.vertex.y)})`
    : t('value.none');
  const rootsText =
    model.roots.length === 0
      ? t('roots.none')
      : `${t(model.roots.length === 1 ? 'roots.one' : 'roots.two')}: ${model.roots.map(formatNumber).join(', ')}`;

  return (
    <div className="experiment">
      <div className="experiment__main">
        <figure className="experiment__figure">
          <FunctionGraph model={model} formula={model.formula} locale={locale} />
          <figcaption className="muted">{t('graph.hint')}</figcaption>
        </figure>

        <section className="panel" aria-labelledby="controls-heading">
          <h2 id="controls-heading" className="panel__heading">
            {t('mode.label')}
          </h2>
          <div className="segmented" role="group" aria-label={t('mode.label')}>
            <button
              type="button"
              aria-pressed={coefficients.mode === 'linear'}
              onClick={() => changeMode('linear')}
            >
              {t('mode.linear')}
            </button>
            <button
              type="button"
              aria-pressed={coefficients.mode === 'quadratic'}
              onClick={() => changeMode('quadratic')}
            >
              {t('mode.quadratic')}
            </button>
          </div>

          <div className="controls">
            <CoefficientControl id="coef-a" label={t('control.a')} value={coefficients.a} onChange={(value) => updateCoefficient('a', value)} />
            <CoefficientControl id="coef-b" label={t('control.b')} value={coefficients.b} onChange={(value) => updateCoefficient('b', value)} />
            <CoefficientControl
              id="coef-c"
              label={t('control.c')}
              value={coefficients.c}
              disabled={coefficients.mode === 'linear'}
              onChange={(value) => updateCoefficient('c', value)}
            />
          </div>
          <p className="muted small">{t('reset.default')}</p>
        </section>
      </div>

      <div className="experiment__details">
        <section className="panel" aria-label={t('readout.formula')}>
          <h2 className="panel__heading">{t('readout.formula')}</h2>
          <p className="formula" data-testid="formula">
            {model.formula}
          </p>
          <dl className="readouts">
            <div>
              <dt>{t('readout.yIntercept')}</dt>
              <dd data-testid="readout-intercept">{formatNumber(model.yIntercept)}</dd>
            </div>
            {coefficients.mode === 'linear' ? (
              <div>
                <dt>{t('readout.slope')}</dt>
                <dd data-testid="readout-slope">{formatNumber(model.slope ?? 0)}</dd>
              </div>
            ) : (
              <>
                <div>
                  <dt>{t('readout.vertex')}</dt>
                  <dd data-testid="readout-vertex">{vertexText}</dd>
                </div>
                <div>
                  <dt>{t('readout.axis')}</dt>
                  <dd data-testid="readout-axis">
                    {model.axisOfSymmetry === undefined ? t('value.none') : `x = ${formatNumber(model.axisOfSymmetry)}`}
                  </dd>
                </div>
                <div>
                  <dt>{t('readout.opening')}</dt>
                  <dd>{t(`opening.${model.opening === 'down' ? 'down' : 'up'}`)}</dd>
                </div>
              </>
            )}
            <div>
              <dt>{t('readout.roots')}</dt>
              <dd data-testid="readout-roots">{rootsText}</dd>
            </div>
          </dl>

          <button
            type="button"
            className="button button--secondary"
            onClick={() => {
              services.analytics.track({
                type: 'experiment_complete',
                experimentId: manifest.id,
                moduleVersion: manifest.moduleVersion,
                locale,
              });
              setCompleted(true);
            }}
            data-testid="complete-button"
          >
            {t('complete.button')}
          </button>
          {completed ? (
            <p className="muted small" role="status" data-testid="complete-note">
              {t('complete.thanks')}
            </p>
          ) : null}
        </section>

        <section className="panel panel--notes" aria-labelledby="notes-heading">
          <h2 id="notes-heading" className="panel__heading">
            {t('meta.formulaHeading')}
          </h2>
          <p className="small">{t('teaching.prompt')}</p>
          <h3 className="panel__subheading">{t('meta.assumptions')}</h3>
          <ul className="notes-list">
            {model.assumptions.map((assumption) => (
              <li key={assumption}>{t(`assumption.${assumption}`)}</li>
            ))}
          </ul>
          {model.warnings.length > 0 ? (
            <ul className="warnings" data-testid="model-warnings">
              {model.warnings.map((warning) => (
                <li key={warning}>{warningText(warning, locale)}</li>
              ))}
            </ul>
          ) : null}
          <p className="muted small">{t('readout.extrema')}: {model.extrema ? `${t(`opening.${model.extrema.kind === 'min' ? 'up' : 'down'}`)} · ${vertexText}` : t('value.none')}</p>
        </section>
      </div>
    </div>
  );
}
