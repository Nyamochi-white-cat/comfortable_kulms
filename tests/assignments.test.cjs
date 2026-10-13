const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const SOURCE = fs.readFileSync(path.join(__dirname, "..", "src", "assignments.js"), "utf8");
const ORIGIN = "https://lms.test";
const CACHE_KEY = "kulms-assignments";

function makeResponse(url, body, overrides) {
  return Object.assign({
    ok: true,
    redirected: false,
    url,
    headers: { get: () => "application/json" },
    json: async () => body,
  }, overrides || {});
}

function courseList(courses) {
  return { site_collection: courses.map((id) => ({ id, title: `Course ${id}`, type: "course" })) };
}

function makeCourses(ids) {
  return ids.map((id) => ({ id, name: `Course ${id}`, url: `${ORIGIN}/portal/site/${id}` }));
}

function assignmentRecord(courseId, suffix, deadline) {
  return {
    entityId: `assignment-${courseId}-${suffix}`,
    title: `Task ${courseId}-${suffix}`,
    dueTime: deadline || Date.now() + 5 * 86400000,
  };
}

function defaultBodyForPath(requestPath, options) {
  const assignmentMatch = requestPath.match(/^\/direct\/assignment\/site\/([^/.]+)\.json$/);
  if (assignmentMatch) {
    const courseId = decodeURIComponent(assignmentMatch[1]);
    if ((options.emptyCourses || []).includes(courseId)) return { assignment_collection: [] };
    return { assignment_collection: [assignmentRecord(courseId, "1")] };
  }

  const quizMatch = requestPath.match(/^\/direct\/sam_pub\/context\/([^/.]+)\.json$/);
  if (quizMatch) {
    const courseId = decodeURIComponent(quizMatch[1]);
    if ((options.emptyQuizCourses || []).includes(courseId)) return { sam_pub_collection: [] };
    return {
      sam_pub_collection: [{
        title: `Quiz ${courseId}`,
        dueDate: Date.now() + 6 * 86400000,
        publishedAssessmentId: `quiz-${courseId}`,
      }],
    };
  }

  if (/^\/direct\/site\/[^/]+\/pages\.json$/.test(requestPath)) {
    return [{ tools: [
      { toolId: "sakai.assignment.grades", id: "assignment-tool" },
      { toolId: "sakai.samigo", id: "quiz-tool" },
    ] }];
  }

  if (/^\/direct\/assignment\/item\/[^/]+\.json$/.test(requestPath)) return { submissions: [] };
  if (requestPath === "/portal") return "<html></html>";
  throw new Error(`Unexpected request: ${requestPath}`);
}

function createHarness(options = {}) {
  const storage = Object.assign({}, options.storage || {});
  const requests = [];
  const updates = [];
  const storageWrites = [];
  let autoComplete = false;
  let messageListener = null;

  const windowObject = {
    location: { origin: ORIGIN, href: `${ORIGIN}/portal` },
    __kulmsSettings: { fetchInterval: 120, dangerHours: 24, warningDays: 5, successDays: 14 },
    __kulmsSettingsReady: Promise.resolve({}),
    __kulmsOnAssignmentsUpdated(assignments, urgency) {
      updates.push({
        assignmentIds: assignments.map((assignment) => assignment.entityId),
        courseIds: Array.from(new Set(assignments.map((assignment) => String(assignment.courseId)))),
        urgency: Object.assign({}, urgency),
      });
    },
  };
  windowObject.top = windowObject;
  windowObject.__kulmsSafeStorage = {
    get(keys, callback) {
      const keyList = Array.isArray(keys) ? keys : [keys];
      const result = {};
      keyList.forEach((key) => { result[key] = storage[key]; });
      queueMicrotask(() => callback(result));
    },
    set(items) {
      storageWrites.push(Object.assign({}, items));
      Object.assign(storage, items);
    },
  };

  const documentObject = {
    visibilityState: "visible",
    head: { appendChild() {} },
    activeElement: null,
    createElement() { return {}; },
    getElementsByTagName(tagName) {
      return tagName === "script" ? [{ textContent: '"loggedIn": true' }] : [];
    },
    addEventListener() {},
  };

  const chromeObject = {
    runtime: {
      id: "test-extension",
      onMessage: { addListener(listener) { messageListener = listener; } },
    },
  };

  function makeRequest(url) {
    const requestPath = new URL(url).pathname + new URL(url).search;
    let resolvePromise;
    let rejectPromise;
    const request = {
      path: requestPath,
      url,
      settled: false,
      promise: new Promise((resolve, reject) => {
        resolvePromise = resolve;
        rejectPromise = reject;
      }),
      resolve(body, overrides) {
        if (request.settled) return;
        request.settled = true;
        resolvePromise(makeResponse(url, body, overrides));
      },
      reject(error) {
        if (request.settled) return;
        request.settled = true;
        rejectPromise(error);
      },
    };
    requests.push(request);

    if (requestPath === "/direct/site.json?_limit=200") {
      queueMicrotask(() => request.resolve(courseList(options.courseIds || [])));
    } else if (autoComplete) {
      queueMicrotask(() => request.resolve(defaultBodyForPath(requestPath, options)));
    }

    return request.promise;
  }

  const sandbox = {
    window: windowObject,
    document: documentObject,
    chrome: chromeObject,
    fetch: makeRequest,
    setInterval() { return 1; },
    console: { log() {}, warn() {}, error() {} },
    URL,
  };
  vm.runInNewContext(SOURCE, vm.createContext(sandbox), { filename: "assignments.js" });

  return {
    window: windowObject,
    storage,
    storageWrites,
    requests,
    updates,
    get api() { return windowObject.__kulmsAssignmentAPI; },
    get messageListener() { return messageListener; },
    set autoComplete(value) {
      autoComplete = value;
      if (value) this.resolveAllPending();
    },
    resolve(pathname, body, overrides) {
      const request = requests.find((candidate) => candidate.path === pathname && !candidate.settled);
      assert.ok(request, `No pending request for ${pathname}`);
      request.resolve(body, overrides);
      return request;
    },
    reject(pathname, error) {
      const request = requests.find((candidate) => candidate.path === pathname && !candidate.settled);
      assert.ok(request, `No pending request for ${pathname}`);
      request.reject(error);
      return request;
    },
    pending(pathname) {
      return requests.filter((request) => !request.settled && (!pathname || request.path === pathname));
    },
    count(pathname) {
      return requests.filter((request) => request.path === pathname).length;
    },
    resolveAllPending() {
      requests.filter((request) => !request.settled).forEach((request) => {
        request.resolve(defaultBodyForPath(request.path, options));
      });
    },
  };
}

async function waitFor(predicate, label) {
  const end = Date.now() + 3000;
  while (Date.now() < end) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function simulateFixedBatches(courseLatencies, batchSize) {
  let finishTime = 0;
  for (let start = 0; start < courseLatencies.length; start += batchSize) {
    finishTime += Math.max(...courseLatencies.slice(start, start + batchSize));
  }
  return finishTime;
}

function simulateDynamicWorkers(courseLatencies, workerCount) {
  const workerFinishTimes = Array(workerCount).fill(0);
  const courseFinishTimes = [];
  courseLatencies.forEach((latency) => {
    let workerIndex = 0;
    for (let index = 1; index < workerFinishTimes.length; index++) {
      if (workerFinishTimes[index] < workerFinishTimes[workerIndex]) workerIndex = index;
    }
    const finishTime = workerFinishTimes[workerIndex] + latency;
    workerFinishTimes[workerIndex] = finishTime;
    courseFinishTimes.push(finishTime);
  });
  return {
    firstPublish: Math.min(...courseFinishTimes),
    allCoursesComplete: Math.max(...courseFinishTimes),
  };
}

async function settleAllRequests(harness, done) {
  harness.autoComplete = true;
  const end = Date.now() + 3000;
  while (Date.now() < end) {
    harness.resolveAllPending();
    await new Promise((resolve) => setImmediate(resolve));
    if (done() && harness.pending().length === 0) return;
  }
  throw new Error("Timed out settling all requests");
}

function cache(assignments, timestamp = Date.now()) {
  return { timestamp, assignments };
}

function cachedAssignment(courseId, suffix) {
  return {
    courseName: `Course ${courseId}`,
    courseId,
    name: `Old ${courseId}-${suffix}`,
    url: `${ORIGIN}/portal/site/${courseId}`,
    deadline: Date.now() + 5 * 86400000,
    closeTime: null,
    deadlineText: "",
    status: "",
    grade: "",
    entityId: `old-${courseId}-${suffix}`,
    type: "assignment",
    allowResubmission: false,
  };
}

test("deterministic latency model compares fixed batches with four dynamic workers", () => {
  // One course latency represents its assignment/quiz bundle, including parallel detail requests.
  const courseLatencies = [1, 7, 2, 9, 3, 1];
  const previousFirstPublish = simulateFixedBatches(courseLatencies, 4);
  const current = simulateDynamicWorkers(courseLatencies, 4);

  assert.equal(previousFirstPublish, 12, "the previous fixed batches publish only after both batches finish");
  assert.equal(current.firstPublish, 1, "the first completed course can publish immediately");
  assert.equal(current.allCoursesComplete, 9, "dynamic workers start queued courses as slots free up");
});

test("publishes a course as soon as its task bundle completes and keeps four dynamic workers", async () => {
  const courseIds = ["A", "B", "C", "D", "E", "F"];
  const harness = createHarness({ courseIds });

  await waitFor(() => harness.requests.some((request) => request.path === "/direct/site.json?_limit=200"), "course list request");
  await waitFor(() => ["A", "B", "C", "D"].every((id) =>
    harness.requests.some((request) => request.path === `/direct/assignment/site/${id}.json`) &&
    harness.requests.some((request) => request.path === `/direct/sam_pub/context/${id}.json`)
  ), "the first four course bundles");
  assert.equal(harness.count("/direct/assignment/site/E.json"), 0, "worker pool should start with four courses");

  harness.resolve("/direct/assignment/site/A.json", {
    assignment_collection: [assignmentRecord("A", "1")],
  });
  await waitFor(() => harness.pending("/direct/assignment/item/assignment-A-1.json").length === 1 &&
    harness.pending("/direct/site/A/pages.json").length === 1, "parallel assignment detail and pages requests");
  assert.equal(harness.count("/direct/site/A/pages.json"), 1);
  assert.equal(harness.pending("/direct/assignment/item/assignment-A-1.json").length, 1);
  assert.equal(harness.pending("/direct/site/A/pages.json").length, 1);

  harness.resolve("/direct/sam_pub/context/A.json", {
    sam_pub_collection: [{ title: "Quiz A", dueDate: Date.now() + 6 * 86400000, publishedAssessmentId: "quiz-A" }],
  });
  await waitFor(() => harness.count("/direct/site/A/pages.json") === 1, "shared pages request");
  assert.equal(harness.count("/direct/site/A/pages.json"), 1, "assignment and quiz URL lookup share pages.json");

  harness.resolve("/direct/site/A/pages.json", defaultBodyForPath("/direct/site/A/pages.json", {}));
  harness.resolve("/direct/assignment/item/assignment-A-1.json", { submissions: [] });
  await waitFor(() => harness.updates.some((update) => update.courseIds.includes("A")), "A progress publication");
  const firstPublication = harness.updates.find((update) => update.courseIds.includes("A"));
  assert.deepEqual(firstPublication.courseIds, ["A"]);
  assert.equal(harness.storage[CACHE_KEY], undefined, "partial results must not be cached");

  await waitFor(() => harness.count("/direct/assignment/site/E.json") === 1, "dynamic worker taking course E");
  assert.equal(harness.count("/direct/assignment/site/F.json"), 0, "no fifth active course while B-E are pending");
  assert.equal(harness.pending("/direct/assignment/site/B.json").length, 1);
  assert.equal(harness.pending("/direct/assignment/site/C.json").length, 1);
  assert.equal(harness.pending("/direct/assignment/site/D.json").length, 1);

  await settleAllRequests(harness, () => Boolean(harness.storage[CACHE_KEY]));
  assert.equal(harness.storage[CACHE_KEY].assignments.length, courseIds.length * 2);
  assert.equal(harness.storageWrites.filter((write) => write[CACHE_KEY]).length, 1, "cache is written once after all courses finish");
});

test("force refresh retains pending course data, applies drop guard to the start baseline, and avoids partial cache writes", async () => {
  const baseline = [
    ...Array.from({ length: 5 }, (_, index) => cachedAssignment("A", index)),
    ...Array.from({ length: 5 }, (_, index) => cachedAssignment("B", index)),
  ];
  const oldCache = cache(baseline);
  const harness = createHarness({ courseIds: ["A", "B"], storage: { [CACHE_KEY]: oldCache } });
  await waitFor(() => harness.updates.length === 1, "fresh cache initial publication");
  assert.equal(harness.requests.filter((request) => request.path.startsWith("/direct/")).length, 0);

  const refresh = harness.api.loadAssignments(true);
  await waitFor(() => harness.requests.some((request) => request.path === "/direct/assignment/site/A.json") &&
    harness.requests.some((request) => request.path === "/direct/assignment/site/B.json"), "forced refresh requests");

  harness.resolve("/direct/assignment/site/A.json", { assignment_collection: [assignmentRecord("A", "new")] });
  harness.resolve("/direct/sam_pub/context/A.json", { sam_pub_collection: [] });
  await waitFor(() => harness.pending("/direct/assignment/item/assignment-A-new.json").length === 1 &&
    harness.pending("/direct/site/A/pages.json").length === 1, "A detail dependencies");
  harness.resolve("/direct/site/A/pages.json", defaultBodyForPath("/direct/site/A/pages.json", {}));
  harness.resolve("/direct/assignment/item/assignment-A-new.json", { submissions: [] });
  await waitFor(() => harness.updates.length >= 2, "partial refreshed snapshot");

  const partial = harness.window.__kulmsAssignments;
  assert.ok(partial.some((assignment) => assignment.courseId === "B" && assignment.entityId === "old-B-0"));
  assert.ok(partial.some((assignment) => assignment.courseId === "A" && assignment.entityId === "assignment-A-new"));
  assert.equal(partial.length, 6);
  assert.equal(harness.storage[CACHE_KEY].timestamp, oldCache.timestamp, "the old complete cache remains untouched during progress");

  harness.resolve("/direct/assignment/site/B.json", { assignment_collection: [] });
  harness.resolve("/direct/sam_pub/context/B.json", { sam_pub_collection: [] });
  await refresh;

  assert.equal(harness.window.__kulmsAssignments.length, 10, "drop guard restores the immutable ten-item baseline");
  assert.equal(harness.count("/direct/site/B/pages.json"), 0, "an empty assignment list skips pages.json");
  assert.equal(harness.storage[CACHE_KEY].timestamp, oldCache.timestamp, "drop-guarded data is not committed to cache");
  assert.equal(harness.storageWrites.filter((write) => write[CACHE_KEY]).length, 0);
});

test("fresh cache bypasses network; all-empty refresh and fatal logout retain existing fallback behavior", async () => {
  const baseline = [cachedAssignment("A", "old")];
  const oldCache = cache(baseline);
  const harness = createHarness({ courseIds: ["A"], storage: { [CACHE_KEY]: oldCache } });
  await waitFor(() => harness.updates.length === 1, "fresh cache publication");
  assert.equal(harness.requests.filter((request) => request.path.startsWith("/direct/")).length, 0);

  const emptyRefresh = harness.api.loadAssignments(true);
  await waitFor(() => harness.pending("/direct/assignment/site/A.json").length === 1 &&
    harness.pending("/direct/sam_pub/context/A.json").length === 1, "empty refresh requests");
  harness.resolve("/direct/assignment/site/A.json", { assignment_collection: [] });
  harness.resolve("/direct/sam_pub/context/A.json", { sam_pub_collection: [] });
  await emptyRefresh;
  assert.deepEqual(harness.window.__kulmsAssignments.map((assignment) => assignment.entityId), ["old-A-old"]);
  assert.equal(harness.storage[CACHE_KEY].timestamp, oldCache.timestamp);

  const fatalHarness = createHarness({ courseIds: ["A", "B"], storage: { [CACHE_KEY]: oldCache } });
  await waitFor(() => fatalHarness.updates.length === 1, "fatal test initial cache publication");
  const fatalRefresh = fatalHarness.api.loadAssignments(true);
  await waitFor(() => fatalHarness.pending("/direct/assignment/site/A.json").length === 1 &&
    fatalHarness.pending("/direct/sam_pub/context/A.json").length === 1 &&
    fatalHarness.pending("/direct/assignment/site/B.json").length === 1 &&
    fatalHarness.pending("/direct/sam_pub/context/B.json").length === 1, "fatal refresh requests");

  fatalHarness.resolve("/direct/assignment/site/A.json", { assignment_collection: [assignmentRecord("A", "new")] });
  fatalHarness.resolve("/direct/sam_pub/context/A.json", { sam_pub_collection: [] });
  await waitFor(() => fatalHarness.pending("/direct/assignment/item/assignment-A-new.json").length === 1 &&
    fatalHarness.pending("/direct/site/A/pages.json").length === 1, "partial result before logout");
  fatalHarness.resolve("/direct/site/A/pages.json", defaultBodyForPath("/direct/site/A/pages.json", {}));
  fatalHarness.resolve("/direct/assignment/item/assignment-A-new.json", { submissions: [] });
  await waitFor(() => fatalHarness.updates.length >= 2, "partial publication before logout");
  assert.ok(fatalHarness.window.__kulmsAssignments.some((assignment) => assignment.entityId === "assignment-A-new"));

  fatalHarness.resolve("/direct/assignment/site/B.json", null, {
    redirected: true,
    url: `${ORIGIN}/portal/login`,
  });
  fatalHarness.resolve("/direct/sam_pub/context/B.json", { sam_pub_collection: [] });
  await fatalRefresh;
  assert.deepEqual(fatalHarness.window.__kulmsAssignments.map((assignment) => assignment.entityId), ["old-A-old"]);
  assert.equal(fatalHarness.storage[CACHE_KEY].timestamp, oldCache.timestamp, "fatal refresh does not replace the full cache");

  const noBaselineHarness = createHarness({ courseIds: ["A", "B"] });
  await waitFor(() => noBaselineHarness.pending("/direct/assignment/site/A.json").length === 1 &&
    noBaselineHarness.pending("/direct/sam_pub/context/A.json").length === 1 &&
    noBaselineHarness.pending("/direct/assignment/site/B.json").length === 1 &&
    noBaselineHarness.pending("/direct/sam_pub/context/B.json").length === 1, "fatal refresh without prior data");
  noBaselineHarness.resolve("/direct/assignment/site/A.json", { assignment_collection: [assignmentRecord("A", "new")] });
  noBaselineHarness.resolve("/direct/sam_pub/context/A.json", { sam_pub_collection: [] });
  await waitFor(() => noBaselineHarness.pending("/direct/assignment/item/assignment-A-new.json").length === 1 &&
    noBaselineHarness.pending("/direct/site/A/pages.json").length === 1, "partial result without a baseline");
  noBaselineHarness.resolve("/direct/site/A/pages.json", defaultBodyForPath("/direct/site/A/pages.json", {}));
  noBaselineHarness.resolve("/direct/assignment/item/assignment-A-new.json", { submissions: [] });
  await waitFor(() => noBaselineHarness.updates.length >= 1, "partial publication without a baseline");
  assert.deepEqual(Array.from(noBaselineHarness.window.__kulmsAssignments, (assignment) => assignment.entityId), ["assignment-A-new"]);
  noBaselineHarness.resolve("/direct/assignment/site/B.json", null, {
    redirected: true,
    url: `${ORIGIN}/portal/login`,
  });
  noBaselineHarness.resolve("/direct/sam_pub/context/B.json", { sam_pub_collection: [] });
  await waitFor(() => Array.isArray(noBaselineHarness.window.__kulmsAssignments) &&
    noBaselineHarness.window.__kulmsAssignments.length === 0, "empty baseline restored after fatal error");
  assert.equal(noBaselineHarness.storage[CACHE_KEY], undefined, "fatal partial results are never cached");
});

test("checked state remains authoritative across per-course publications", async () => {
  const harness = createHarness({ courseIds: ["A", "B"] });
  await waitFor(() => harness.pending("/direct/assignment/site/A.json").length === 1 &&
    harness.pending("/direct/sam_pub/context/A.json").length === 1, "first course requests");

  harness.resolve("/direct/assignment/site/A.json", { assignment_collection: [assignmentRecord("A", "1")] });
  harness.resolve("/direct/sam_pub/context/A.json", { sam_pub_collection: [] });
  await waitFor(() => harness.pending("/direct/assignment/item/assignment-A-1.json").length === 1 &&
    harness.pending("/direct/site/A/pages.json").length === 1, "A dependencies");
  harness.resolve("/direct/site/A/pages.json", defaultBodyForPath("/direct/site/A/pages.json", {}));
  harness.resolve("/direct/assignment/item/assignment-A-1.json", { submissions: [] });
  await waitFor(() => harness.updates.some((update) => update.courseIds.includes("A")), "A publication");

  const assignment = harness.window.__kulmsAssignments.find((item) => item.entityId === "assignment-A-1");
  harness.api.toggleChecked(assignment);
  assert.equal(harness.api.isAssignmentChecked(assignment), true);

  harness.autoComplete = true;
  await waitFor(() => Boolean(harness.storage[CACHE_KEY]), "remaining courses and cache commit");
  const updatedAssignment = harness.window.__kulmsAssignments.find((item) => item.entityId === "assignment-A-1");
  assert.equal(harness.api.isAssignmentChecked(updatedAssignment), true);
});
