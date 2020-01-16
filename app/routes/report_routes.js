// Express docs: http://expressjs.com/en/api.html
const express = require('express')
// Passport docs: http://www.passportjs.org/docs/
const passport = require('passport')

// pull in Mongoose model for reports
const Report = require('../models/report')

// Bull docs: https://github.com/OptimalBits/bull/tree/develop/docs
const Queue = require('bull')
// Bull Arena docs: https://github.com/bee-queue/arena
const Arena = require('bull-arena')
// Connect to a local redis instance locally, and the Heroku-provided URL in production
const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379'
// set up a Reports queue connected to the Redis instance
const reportQueue = new Queue('Reports', REDIS_URL)
// Uniqid docs: https://github.com/adamhalasz/uniqid/
const uniqid = require('uniqid')

// configuration for Bull Arena GUI job monitor
const arena = Arena({
  queues: [
    {
      name: 'Reports',
      hostId: 'A LA MODE Queue Server',
      redis: {
        port: 6379 // Redis port
      }
    }
  ]
},
{
  // Make the arena dashboard become available at {my-site.com}/arena
  basePath: '/arena',
  // Let express handle the listening
  disableListen: true
})

// this is a collection of methods that help us detect situations when we need
// to throw a custom error
const customErrors = require('../../lib/custom_errors')

// we'll use this function to send 404 when non-existant document is requested
const handle404 = customErrors.handle404
// we'll use this function to send 401 when a user tries to modify a resource
// that's owned by someone else
const requireOwnership = customErrors.requireOwnership

// this is middleware that will remove blank fields from `req.body`, e.g.
// { example: { title: '', text: 'foo' } } -> { example: { text: 'foo' } }
const removeBlanks = require('../../lib/remove_blank_fields')
// passing this as a second argument to `router.<verb>` will make it
// so that a token MUST be passed for that route to be available
// it will also set `req.user`
const requireToken = passport.authenticate('bearer', { session: false })

// instantiate a router (mini app that only handles routes)
const router = express.Router()

// const getDate = require('../../lib/get_date')

// Make arena's resources (js/css deps) available at the base app route
router.use('/', arena)

// INDEX
// GET /reports
router.get('/reports', requireToken, (req, res, next) => {
  Report.find()
    .then(reports => {
      // `reports` will be an array of Mongoose documents
      // we want to convert each one to a POJO, so we use `.map` to
      // apply `.toObject` to each one
      return reports.map(report => report.toObject())
    })
    // respond with status 200 and JSON of the reports
    .then(reports => res.status(200).json({ reports: reports }))
    // if an error occurs, pass it to the handler
    .catch(next)
})

// SHOW
// GET /reports/5a7db6c74d55bc51bdf39793
router.get('/reports/:id', requireToken, (req, res, next) => {
  // req.params.id will be set based on the `:id` in the route
  Report.findById(req.params.id)
    .then(handle404)
    // if `findById` is succesful, respond with 200 and "example" JSON
    .then(report => res.status(200).json({ report: report.toObject() }))
    // if an error occurs, pass it to the handler
    .catch(next)
})

/*
const createReportObject = (req, res, next) => {
  // parse URL for
  let parsedUrl = req.body.url.match(/:\/\/(www[0-9]?\.)?(.[^/:]+)/i)
  if (parsedUrl != null && parsedUrl.length > 2 && typeof parsedUrl[2] === 'string' && parsedUrl[2].length > 0) {
    parsedUrl = parsedUrl[2]
  } else {
    parsedUrl = null
  }
  res.locals.reportObject = {
    title: `${getDate()} ${parsedUrl}`,
    url: req.body.url,
    products: res.locals.reportData,
    owner: req.user.id
  }
  next()
}

const createReportDocument = (req, res, next) => {
  Report.create(res.locals.reportObject)
    .then(report => {
      // respond to succesful `create` with status 201 and JSON of new "report"
      res.status(201).json({ report: report.toObject() })
    })

    // if an error occurs, pass it off to our error handler
    // the error handler needs the error message and the `res` object so that it
    // can send an error message back to the client
    .catch(next)
}
*/

// CREATE
// POST /reports
router.post('/reports', requireToken, async (req, res, next) => {
  const url = req.body.url
  // Kick off a new job by adding it to the report queue
  const job = await reportQueue.add('scrape site', { url }, { jobId: uniqid('rj-') })
  // res.status(201).json({ job: job.id })
  // res.json({ id: job.id })
  /*
  scrape(req.body.url)
    .then(data => {
      res.locals.reportData = data
      next()
    })
    */
}
// , createReportObject, createReportDocument
)

// UPDATE
// PATCH /reports/5a7db6c74d55bc51bdf39793
router.patch('/reports/:id', requireToken, removeBlanks, (req, res, next) => {
  // if the client attempts to change the `owner` property by including a new
  // owner, prevent that by deleting that key/value pair
  delete req.body.report.owner

  Report.findById(req.params.id)
    .then(handle404)
    .then(report => {
      // pass the `req` object and the Mongoose record to `requireOwnership`
      // it will throw an error if the current user isn't the owner
      requireOwnership(req, report)

      // pass the result of Mongoose's `.set` to the next `.then`
      return report.set(req.body.report).save()
    })
    // if that succeeded, return 200 and JSON
    .then(report => {
      res.status(200).json({ report: report.toObject() })
    })
    // if an error occurs, pass it to the handler
    .catch(next)
})

// DESTROY
// DELETE /reports/5a7db6c74d55bc51bdf39793
router.delete('/reports/:id', requireToken, (req, res, next) => {
  Report.findById(req.params.id)
    .then(handle404)
    .then(report => {
      // throw an error if current user doesn't own `report`
      requireOwnership(req, report)
      // delete the report ONLY IF the above didn't throw
      report.deleteOne()
    })
    // send back 204 and no content if the deletion succeeded
    .then(() => res.sendStatus(204))
    // if an error occurs, pass it to the handler
    .catch(next)
})

reportQueue.on('global:completed', (jobId, result) => {
  console.log(`Job completed with result ${result}`)
})

module.exports = router
