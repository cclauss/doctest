
///          >>>
///          >>>                        >>>                         >>>
///     >>>>>>>>   >>>>>>>    >>>>>>>   >>>>>   >>>>>>>    >>>>>>   >>>>>
///    >>>   >>>  >>>   >>>  >>>   >>>  >>>    >>>   >>>  >>>       >>>
///    >>>   >>>  >>>   >>>  >>>        >>>    >>>>>>>>>  >>>>>>>>  >>>
///    >>>   >>>  >>>   >>>  >>>   >>>  >>>    >>>             >>>  >>>
///     >>>>>>>>   >>>>>>>    >>>>>>>    >>>>   >>>>>>>    >>>>>>    >>>>
///    .....................x.......xx.x.................................

'use strict';

var fs = require ('fs');
var pathlib = require ('path');
var util = require ('util');

var CoffeeScript = require ('coffeescript');
var esprima = require ('esprima');
var _show = require ('sanctuary-show');
var Z = require ('sanctuary-type-classes');

var common = require ('./common');


function inferType(path) {
  switch (pathlib.extname (path)) {
    case '.coffee': return 'coffee';
    case '.js':     return 'js';
    default:        return null;
  }
}

var rewriters = {coffee: rewrite$coffee, js: rewrite$js};

function evaluate(options, source, path) {
  return options.module === 'commonjs' ?
    commonjsEval (options, source, path) :
    functionEval (options, source);
}

module.exports = function(path, options) {
  if (options.module != null &&
      options.module !== 'amd' &&
      options.module !== 'commonjs') {
    return Promise.reject (new Error (
      'Invalid module `' + options.module + "'"
    ));
  }
  if (options.type != null &&
      options.type !== 'coffee' &&
      options.type !== 'js') {
    return Promise.reject (new Error (
      'Invalid type `' + options.type + "'"
    ));
  }

  var type = options.type == null ? inferType (path) : options.type;
  if (type == null) {
    return Promise.reject (new Error (
      'Cannot infer type from extension'
    ));
  }

  var source = toModule (
    rewriters[type] (
      {prefix: options.prefix == null ? '' : options.prefix,
       openingDelimiter: options.openingDelimiter,
       closingDelimiter: options.closingDelimiter,
       sourceType: 'script'},
      common.sanitizeFileContents (fs.readFileSync (path, 'utf8'))
    ),
    options.module,
    options.logFunction
  );

  if (options.print) {
    console.log (source.replace (/\n$/, ''));
    return Promise.resolve ([]);
  } else if (options.silent) {
    return evaluate (options, source, path);
  } else {
    console.log ('running doctests in ' + path + '...');
    return (evaluate (options, source, path))
      .then (function(results) {
        log (results);
        return results;
      });
  }
};

//  indentN :: (Integer, String) -> String
function indentN(n, s) {
  return s.replace (/^(?!$)/gm, (Array (n + 1)).join (' '));
}

//  object :: Array (Array2 String Any) -> Object
function object(pairs) {
  return pairs.reduce (function(object, pair) {
    object[pair[0]] = pair[1];
    return object;
  }, {});
}

//  quote :: String -> String
function quote(s) {
  return "'" + s.replace (/'/g, "\\'") + "'";
}

//  show :: a -> String
function show(x) {
  return Object.prototype.toString.call (x) === '[object Error]' ?
    String (x) :
    _show (x);
}

//  stripLeading :: (Number, String, String) -> String
//
//  > stripLeading (1, '.', 'xxx')
//  'xxx'
//  > stripLeading (1, '.', '...xxx...')
//  '..xxx...'
//  > stripLeading (Infinity, '.', '...xxx...')
//  'xxx...'
function stripLeading(n, c, s) {
  var idx = 0;
  while (idx < n && s.charAt (idx) === c) idx += 1;
  return s.slice (idx);
}

//  iifeWrap :: String -> String
function iifeWrap(s) {
  return 'void function() {\n' + indentN (2, s) + '}.call(this);';
}

//  toModule :: (String, String?, String?) -> String
function toModule(source, moduleType, logFunction) {
  switch (moduleType) {
    case 'amd':
      return common.unlines ([
        source,
        'function define() {',
        '  for (var idx = 0; idx < arguments.length; idx += 1) {',
        '    if (typeof arguments[idx] == "function") {',
        '      arguments[idx]();',
        '      break;',
        '    }',
        '  }',
        '}'
      ]);
    case 'commonjs':
      return iifeWrap (common.unlines ([
        'var __doctest = {',
        '  require: require,',
        '  queue: [],',
        '  enqueue: function(io) { this.queue.push(io); },',
        '  logMediator: {emit: function() {}}',
        '};',
        (logFunction == null ? '' : common.unlines ([
          '',
          'var ' + logFunction + ' = function(channel) {',
          '  return function(value) {',
          '    __doctest.logMediator.emit (channel, value);',
          '  };',
          '};',
          ''
        ])),
        iifeWrap (source),
        '',
        '(module.exports || exports).__doctest = __doctest;'
      ]));
    default:
      return source;
  }
}

var CLOSED = 'closed';
var OPEN = 'open';
var INPUT = 'input';
var OUTPUT = 'output';
var LOG = 'log';

var MATCH_LOG = /^\[([a-zA-Z]+)\]:/;

//  normalizeTest :: { output :: { value :: String } } -> Undefined
function normalizeTest($test) {
  $test[OUTPUT].values.forEach (function($output) {
    var match = $output.value.match (/^![ ]?([^:]*)(?::[ ]?(.*))?$/);
    $test['!'] = match != null;
    if ($test['!']) {
      $output.value = 'new ' + match[1] + '(' + quote (match[2] || '') + ')';
    }
  });
}

function processLine(
  options,        // :: { prefix :: String
                  //    , openingDelimiter :: Nullable String
                  //    , closingDelimiter :: Nullable String }
  accum,          // :: { state :: State, tests :: Array Test }
  line,           // :: String
  input,          // :: Test -> Undefined
  output,         // :: Test -> Undefined
  appendToInput,  // :: Test -> Undefined
  appendToOutput  // :: Test -> Undefined
) {
  var $test, value;
  var prefix = options.prefix;
  if (line.slice (0, prefix.length) === prefix) {
    var trimmedLine = (line.slice (prefix.length)).replace (/^\s*/, '');
    if (accum.state === CLOSED) {
      if (trimmedLine === options.openingDelimiter) accum.state = OPEN;
    } else if (trimmedLine === options.closingDelimiter) {
      accum.state = CLOSED;
    } else if (trimmedLine.charAt (0) === '>') {
      accum.state = INPUT;
      value = stripLeading (1, ' ', stripLeading (1, '>', trimmedLine));
      accum.tests.push ($test = {});
      $test[INPUT] = {value: value};
      $test[OUTPUT] = {values: []};
      input ($test);
    } else if (accum.state === INPUT && trimmedLine.charAt (0) === '.') {
      value = stripLeading (1, ' ', stripLeading (Infinity, '.', trimmedLine));
      $test = accum.tests[accum.tests.length - 1];
      $test[INPUT].value += '\n' + value;
      appendToInput ($test);
    } else if ((accum.state === OUTPUT || accum.state === LOG) &&
               (trimmedLine.charAt (0) === '.')) {
      value = stripLeading (1, ' ', stripLeading (Infinity, '.', trimmedLine));
      $test = accum.tests[accum.tests.length - 1];
      $test[OUTPUT].values[$test[OUTPUT].values.length - 1].value += '\n'
                                                                  + value;
      appendToOutput ($test);
    } else if (MATCH_LOG.test (trimmedLine)) {
      accum.state = LOG;
      value = stripLeading (1, ' ', trimmedLine.replace (MATCH_LOG, ''));
      $test = accum.tests[accum.tests.length - 1];
      $test[OUTPUT].values.push ({
        channel: MATCH_LOG.exec (trimmedLine)[1],
        value: value
      });
      if ($test[OUTPUT].values.length === 1) {
        output ($test);
      }
    } else if (accum.state === INPUT || accum.state === LOG) {
      accum.state = OUTPUT;
      value = trimmedLine;
      $test = accum.tests[accum.tests.length - 1];
      $test[OUTPUT].values.push ({
        channel: null,
        value: value
      });
      if ($test[OUTPUT].values.length === 1) {
        output ($test);
      }
    }
  }
}

//  Location = { start :: { line :: Integer, column :: Integer }
//             ,   end :: { line :: Integer, column :: Integer } }

//  transformComments
//  :: ( String
//      , Array { type :: String, value :: String, loc :: Location } )
//  -> Array { commentIndex :: Integer
//           ,            ! :: Boolean
//           ,        input :: { value :: String, loc :: Location }
//           ,       output :: { value :: String, loc :: Location } }
//
//  Returns the doctests present in the given esprima comment objects.
//
//  > transformComments ({prefix: ''}, [{
//  .   type: 'Line',
//  .   value: ' > 6 * 7',
//  .   loc: {start: {line: 1, column: 0}, end: {line: 1, column: 10}}
//  . }, {
//  .   type: 'Line',
//  .   value: ' 42',
//  .   loc: {start: {line: 2, column: 0}, end: {line: 2, column: 5}}
//  . }])
//  [{
//  .   commentIndex: 1,
//  .   '!': false,
//  .   input: {
//  .     value: '6 * 7',
//  .     loc: {start: {line: 1, column: 0}, end: {line: 1, column: 10}}},
//  .   output: {
//  .     values: [{channel: null, value: '42'}],
//  .     loc: {start: {line: 2, column: 0}, end: {line: 2, column: 5}}}
//  . }]
function transformComments(options, comments) {
  var result = comments.reduce (function(accum, comment, commentIndex) {
    return (comment.value.split ('\n')).reduce (function(accum, line, idx) {
      var normalizedLine, start, end;
      if (comment.type === 'Block') {
        normalizedLine = line.replace (/^\s*[*]?\s*/, '');
        start = end = {line: comment.loc.start.line + idx};
      } else if (comment.type === 'Line') {
        normalizedLine = line.replace (/^\s*/, '');
        start = comment.loc.start;
        end = comment.loc.end;
      }
      processLine (
        options,
        accum,
        normalizedLine,
        function($test) {
          $test[INPUT].loc = {start: start, end: end};
        },
        function($test) {
          $test.commentIndex = commentIndex;
          $test[OUTPUT].loc = {start: start, end: end};
        },
        function($test) {
          $test[INPUT].loc.end = end;
        },
        function($test) {
          $test[OUTPUT].loc.end = end;
        }
      );
      return accum;
    }, accum);
  }, {state: options.openingDelimiter == null ? OPEN : CLOSED, tests: []});

  var $tests = result.tests;
  $tests.forEach (normalizeTest);
  return $tests;
}

//  substring
//  :: ( String
//     , { line :: Integer, column :: Integer }
//     , { line :: Integer, column :: Integer } )
//  -> String
//
//  Returns the substring between the start and end positions.
//  Positions are specified in terms of line and column rather than index.
//  {line: 1, column: 0} represents the first character of the first line.
//
//  > substring ('hello\nworld', {line: 1, column: 3}, {line: 2, column: 2})
//  'lo\nwo'
//  > substring ('hello\nworld', {line: 1, column: 0}, {line: 1, column: 0})
//  ''
function substring(input, start, end) {
  var lines = input.split (/^/m);
  return (
    start.line === end.line ?
      lines[start.line - 1].slice (start.column, end.column) :
    end.line === Infinity ?
      lines[start.line - 1].slice (start.column) +
      (lines.slice (start.line)).join ('') :
    // else
      lines[start.line - 1].slice (start.column) +
      (lines.slice (start.line, end.line - 1)).join ('') +
      lines[end.line - 1].slice (0, end.column)
  );
}

function wrap$js(test, sourceType) {
  var ast = esprima.parse (test[INPUT].value, {sourceType: sourceType});
  var type = ast.body[0].type;
  return type === 'FunctionDeclaration' ||
         type === 'ImportDeclaration' ||
         type === 'VariableDeclaration' ?
    test[INPUT].value :
    // TODO: Why are we enqueing two things if it could just be one structure?
    [
      '__doctest.enqueue({',
      '  type: "' + INPUT + '",',
      '  thunk: function() {',
      '    return (',
      indentN (6, test[INPUT].value),
      '    );',
      '  }',
      '});'
    ].concat (test[OUTPUT].values.length === 0 ? [] : [
      '__doctest.enqueue({',
      '  type: "' + OUTPUT + '",',
      '  ":": ' + test[OUTPUT].loc.start.line + ',',
      '  "!": ' + test['!'] + ',',
      '  thunk: function() {',
      '    return [',
      indentN (6, test[OUTPUT].values.map (function(out) {
        return '{channel: ' + JSON.stringify (out.channel) +
               ', value: (\n' + indentN (2, out.value) + '\n)}';
      }).join (',\n')),
      '    ];',
      '  }',
      '});'
    ]).join ('\n');
}

function wrap$coffee(test) {
  return [
    '__doctest.enqueue {',
    '  type: "' + INPUT + '"',
    '  thunk: ->',
    indentN (4, test[INPUT].value),
    '}'
  ].concat (test[OUTPUT].values.length === 0 ? [] : [
    '__doctest.enqueue {',
    '  type: "' + OUTPUT + '"',
    '  ":": ' + test[OUTPUT].loc.start.line,
    '  "!": ' + test['!'],
    '  thunk: -> [',
    indentN (4, test[OUTPUT].values.map (function(out) {
      return '{channel: ' + JSON.stringify (out.channel) +
             ', value: (\n' + indentN (2, out.value) + '\n)}';
    }).join ('\n')),
    '  ]',
    '}'
  ]).join ('\n');
}

function rewrite$js(options, input) {
  //  1. Locate block comments and line comments within the input text.
  //
  //  2. Create a list of comment chunks from the list of line comments
  //     located in step 1 by grouping related comments.
  //
  //  3. Create a list of code chunks from the remaining input text.
  //     Note that if there are N comment chunks there are N + 1 code
  //     chunks. A trailing empty comment enables the final code chunk
  //     to be captured:

  var bookend = {
    value: '',
    loc: {start: {line: Infinity, column: Infinity}}
  };

  //  4. Map each comment chunk in the list produced by step 2 to a
  //     string of JavaScript code derived from the chunk's doctests.
  //
  //  5. Zip the lists produced by steps 3 and 4.
  //
  //  6. Find block comments in the source code produced by step 5.
  //     (The locations of block comments located in step 1 are not
  //     applicable to the rewritten source.)
  //
  //  7. Repeat steps 3 through 5 for the list of block comments
  //     produced by step 6 (substituting "step 6" for "step 2").

  function getComments(input) {
    var ast = esprima.parse (input, {
      comment: true,
      loc: true,
      sourceType: options.sourceType
    });
    return ast.comments;
  }

  function wrapCode(js) {
    return wrap$js (js, options.sourceType);
  }

  //  comments :: { Block :: Array Comment, Line :: Array Comment }
  var comments = (getComments (input)).reduce (function(comments, comment) {
    comments[comment.type].push (comment);
    return comments;
  }, {Block: [], Line: []});

  var blockTests = transformComments (options, comments.Block);
  var lineTests = transformComments (options, comments.Line);

  var chunks = lineTests
    .concat ([object ([[INPUT, bookend], [OUTPUT, []]])])
    .reduce (function(accum, test) {
      accum.chunks.push (substring (input, accum.loc, test[INPUT].loc.start));
      accum.loc = (test[OUTPUT].values.length === 0 ?
                   test[INPUT] :
                   test[OUTPUT]).loc.end;
      return accum;
    }, {chunks: [], loc: {line: 1, column: 0}})
    .chunks;

  //  source :: String
  var source = lineTests
    .map (wrapCode)
    .concat ([''])
    .reduce (function(accum, s, idx) { return accum + chunks[idx] + s; }, '');

  return getComments (source)
    .filter (function(comment) { return comment.type === 'Block'; })
    .concat ([bookend])
    .reduce (function(accum, comment, idx) {
      accum.chunks.push (
        substring (source, accum.loc, comment.loc.start),
        blockTests
          .filter (function(test) { return test.commentIndex === idx; })
          .map (wrapCode)
          .join ('\n')
      );
      accum.loc = comment.loc.end;
      return accum;
    }, {chunks: [], loc: {line: 1, column: 0}})
    .chunks
    .join ('');
}

module.exports.rewrite$js = rewrite$js;

function rewrite$coffee(options, input) {
  var lines = input.match (/^.*(?=\n)/gm);
  var chunks = lines.reduce (function(accum, line, idx) {
    var isComment = /^[ \t]*#(?!##)/.test (line);
    var current = isComment ? accum.commentChunks : accum.literalChunks;
    if (isComment === accum.isComment) {
      current[current.length - 1].lines.push (line);
    } else {
      current.push ({lines: [line], loc: {start: {line: idx + 1}}});
    }
    accum.isComment = isComment;
    return accum;
  }, {
    literalChunks: [{lines: [], loc: {start: {line: 1}}}],
    commentChunks: [],
    isComment: false
  });

  var testChunks = chunks.commentChunks.map (function(commentChunk) {
    var result = commentChunk.lines.reduce (function(accum, line, idx) {
      var match = line.match (/^([ \t]*)#[ \t]*(.*)$/);
      processLine (
        options,
        accum,
        match[2],
        function($test) {
          $test.indent = match[1];
        },
        function($test) {
          $test[OUTPUT].loc = {
            start: {line: commentChunk.loc.start.line + idx}
          };
        },
        function() {},
        function() {}
      );
      return accum;
    }, {state: options.openingDelimiter == null ? OPEN : CLOSED, tests: []});

    return result.tests.map (function($test) {
      normalizeTest ($test);
      return indentN ($test.indent.length, wrap$coffee ($test));
    });
  });

  function append(s, line) { return s + line + '\n'; }
  return CoffeeScript.compile (
    chunks.literalChunks.reduce (function(s, chunk, idx) {
      return (testChunks[idx] || []).reduce (
        append,
        chunk.lines.reduce (append, s)
      );
    }, '')
  );
}

function functionEval(options, source) {
  //  Functions created via the Function function are always run in the
  //  global context, which ensures that doctests can't access variables
  //  in _this_ context.
  //
  //  The `evaluate` function takes one argument, named `__doctest`.
  var evaluate = Function ('__doctest', source);
  var queue = [];
  evaluate ({enqueue: function(io) { queue.push (io); }});
  return run (options, queue);
}

function commonjsEval(options, source, path) {
  var abspath =
  (pathlib.resolve (path)).replace (/[.][^.]+$/, '-' + Date.now () + '.js');

  function cleanup(f) {
    return function(x) {
      return (util.promisify (fs.unlink) (abspath)).then (function() {
        return f (x);
      });
    };
  }

  return (util.promisify (fs.writeFile) (abspath, source))
    .then (function() {
      var module = require (abspath);
      return run (options,
                  module.__doctest.queue,
                  module.__doctest.logMediator);
    })
    .then (cleanup (Promise.resolve.bind (Promise)),
           cleanup (Promise.reject.bind (Promise)));
}

function run(options, queue, optionalLogMediator) {
  // TODO: Remove optionality once all source types have log mediators.
  var logMediator = optionalLogMediator || {};
  return queue.reduce (function(p, io) {
    return p.then (function(accum) {
      var thunk = accum.thunk;

      if (io.type === INPUT) {
        if (thunk != null) thunk ();
        accum.thunk = io.thunk;
        return accum;
      }

      var errored;
      var expecteds = io.thunk ();
      var outputs = [];

      accum.thunk = null;

      logMediator.emit = function(channel, value) {
        outputs.push ({channel: channel, value: value});
      };

      try {
        outputs.push ({channel: null, value: thunk ()});
        errored = false;
      } catch (err) {
        outputs.push ({channel: null, value: err});
        errored = true;
      }

      function awaitOutput() {
        return new Promise (function(res) {
          var t = setTimeout (done, options.logTimeout);
          logMediator.emit = function(channel, value) {
            outputs.push ({channel: channel, value: value});
            clearTimeout (t);
            t = setTimeout (done, options.logTimeout);
          };
          function done() {
            logMediator.emit = function() {};
            clearTimeout (t);
            res ();
          }
        });
      }

      return typeof options.logFunction === 'string' ?
             (awaitOutput ()).then (verifyOutput) :
             Promise.resolve (verifyOutput ());

      function showError(value) {
        return '! ' + value.name + value.message.replace (/^(?!$)/, ': ');
      }

      function showOutput(asError, output) {
        return output.channel == null ? (
          asError ? showError (output.value) : show (output.value)
        ) : (
          '[' + output.channel + ']: ' + show (output.value)
        );
      }

      function verifyOutput() {
        outputs.forEach (function(output, idx) {
          var expected = expecteds[idx];
          var pass, actualRepr, expectedRepr;

          if (expected) {
            expectedRepr = showOutput (io['!'], expected);
            if (errored) {
              var name = output.value.name;
              var message = output.value.message;
              pass = io['!'] &&
                     name === expected.value.name &&
                     message ===
                     expected.value.message.replace (/^$/, message);
              actualRepr = io['!'] && expected.value.message === '' ?
                           '! ' + output.value.name :
                           showOutput (true, output);
            } else {
              pass = !io['!'] && Z.equals (output.value, expected.value);
              actualRepr = showOutput (false, output);
            }
          } else {
            pass = false;
            expectedRepr = 'no output';
            actualRepr = showOutput (errored, output);
          }

          accum.results.push ([
            pass,
            actualRepr,
            expectedRepr,
            io[':']
          ]);
        });

        expecteds.slice (outputs.length).forEach (function(expected) {
          accum.results.push ([
            false,
            'no output',
            showOutput (io['!'], expected),
            io[':']
          ]);
        });

        return accum;
      }

    });
  }, Promise.resolve ({results: [], thunk: null})).then (function(reduced) {
    return reduced.results;
  });
}

module.exports.run = run;

function log(results) {
  console.log (results.reduce (function(s, tuple) {
    return s + (tuple[0] ? '.' : 'x');
  }, ''));
  results.forEach (function(tuple) {
    if (!tuple[0]) {
      console.log ('FAIL: expected ' + tuple[2] + ' on line ' + tuple[3] +
                   ' (got ' + tuple[1] + ')');
    }
  });
}

module.exports.log = log;
