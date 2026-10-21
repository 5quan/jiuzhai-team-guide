function timelineStops(steps, pointFor) {
  const moving = step => !['visit', 'rest'].includes(step.mode);
  const stops = [];
  for (const step of steps) {
    const spotId = pointFor(step);
    const previous = stops.at(-1);
    if (!moving(step) && previous && (previous.spotId === spotId || step.spotIds.includes(previous.spotId)) && previous.steps.every(moving)) {
      previous.steps.push(step);
      previous.step = step;
    } else stops.push({ spotId, step, steps: [step] });
  }
  return stops;
}
