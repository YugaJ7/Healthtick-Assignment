// Shows the result of the latency check as numbers and a small bar chart.

const SVG_NS = 'http://www.w3.org/2000/svg';
const CHART_WIDTH = 280;
const CHART_HEIGHT = 110;
const CHART_BASELINE = 96; // room below for nothing, above for the tallest bar
const BAR_GAP = 1;
const METHOD = 'Measured in this page with one clock: a touch is sent to the Back button of the device, '
  + 'and the clock stops when a video frame showing the button lit up has been drawn. '
  + 'It covers the network both ways, Android, and encoding and decoding the video.';

const ms = (value) => `${Math.round(value)} ms`;

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function svg(tag, attributes) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
  return node;
}

/**
 * One bar per tap, in the order they were made, scaled to the slowest tap.
 * @param {number[]} samples milliseconds
 * @param {number} median
 */
function chart(samples, median) {
  const highest = Math.max(...samples);
  const step = CHART_WIDTH / samples.length;
  const root = svg('svg', { viewBox: `0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`, role: 'img', class: 'chart' });
  root.append(Object.assign(svg('title', {}), { textContent: `${samples.length} taps, from ${Math.min(...samples)} to ${highest} ms` }));
  samples.forEach((sample, index) => {
    const height = Math.max(1, (sample / highest) * CHART_BASELINE);
    root.append(svg('rect', { x: index * step, y: CHART_BASELINE - height, width: Math.max(1, step - BAR_GAP), height, class: 'bar' }));
  });
  const medianY = CHART_BASELINE - (median / highest) * CHART_BASELINE;
  root.append(svg('line', { x1: 0, x2: CHART_WIDTH, y1: medianY, y2: medianY, class: 'median-line' }));
  return root;
}

/**
 * @param {HTMLElement} container emptied and refilled
 * @param {object} report
 * @param {{ count: number, median: number, p95: number, min: number, max: number } | null} report.total
 * @param {{ median: number } | null} report.roundTrip
 * @param {number} report.timeouts taps that showed no reaction in time
 * @param {number[]} report.samplesMs
 */
export function renderLatencyReport(container, report) {
  if (!report.total) {
    container.replaceChildren(element('p', `No tap showed a reaction (${report.timeouts} tried). The Back button of the device must be visible at the bottom left of the screen.`));
    return;
  }
  const figures = element('dl', undefined, 'figures');
  const rows = [
    ['Median', ms(report.total.median)], ['95th percentile', ms(report.total.p95)],
    ['Fastest', ms(report.total.min)], ['Slowest', ms(report.total.max)],
    ['Taps measured', report.timeouts > 0 ? `${report.total.count} (${report.timeouts} without a reaction)` : String(report.total.count)],
  ];
  if (report.roundTrip) rows.push(['Round trip to the server', ms(report.roundTrip.median)]);
  for (const [name, value] of rows) figures.append(element('dt', name), element('dd', value));
  container.replaceChildren(
    figures,
    chart(report.samplesMs, report.total.median),
    element('p', 'Each bar is one tap, in order. The line is the median.', 'caption'),
    element('p', METHOD, 'caption'),
  );
}
