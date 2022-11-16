process.env.SENTRY_DSN =
  process.env.SENTRY_DSN ||
  'https://75ba75b6017a473fb5a5bd25f5118dec@errors.cozycloud.cc/15'

const {
  BaseKonnector,
  log,
  requestFactory,
  errors,
  cozyClient
} = require('cozy-konnector-libs')

const models = cozyClient.new.models
const { Qualification } = models.document

const request = requestFactory({
  // debug: true,
  json: true,
  jar: true
})

const { format } = require('date-fns')
const moment = require('moment')
const crypto = require('crypto')

module.exports = new BaseKonnector(start)

async function start(fields) {
  await this.deactivateAutoSuccessfulLogin()
  await authenticate.bind(this)(fields)
  await this.notifySuccessfulLogin()
  const accounts = await request('https://api.payfit.com/auth/accounts')

  for (const account of accounts) {
    // only handle employee accounts
    if (account.account.userRole !== 'employee') continue
    await fetchAccount.bind(this)(fields, account)
  }
}

async function fetchAccount(fields, account) {
  const { companyId, employeeId } = account.account
  await request('https://api.payfit.com/auth/updateCurrentAccount', {
    qs: { companyId, employeeId }
  })
  const payrolls = await fetchPayrolls({ companyId, employeeId })
  const { companyName } = await fetchProfileInfo()
  const documents = convertPayrollsToCozy(payrolls, companyName)
  moment.locale('fr')
  await this.saveBills(documents, fields, {
    linkBankOperations: false,
    fileIdAttributes: ['vendorId'],
    processPdf: (entry, text) => {
      const formatedText = text.split('\n').join(' ').replace(/ /g, '')

      // Extract PDF data before 06-2022
      if (
        formatedText.match(
          /VIREMENT([0-9,]*)DATEDEPAIEMENT([0-9]{2})(JANVIER|FÉVRIER|MARS|AVRIL|MAI|JUIN|JUILLET|AOÛT|SEPTEMBRE|OCTOBRE|NOVEMBRE|DÉCEMBRE)([0-9]{4})/
        )
      ) {
        const matchedStrings = text
          .split('\n')
          .join(' ')
          .replace(/ /g, '')
          .match(
            /VIREMENT([0-9,]*)DATEDEPAIEMENT([0-9]{2})(JANVIER|FÉVRIER|MARS|AVRIL|MAI|JUIN|JUILLET|AOÛT|SEPTEMBRE|OCTOBRE|NOVEMBRE|DÉCEMBRE)([0-9]{4})/
          )
        const values = matchedStrings
          .slice(1)
          .map(data => data.trim().replace(/\s\s+/g, ' '))
        const amount = parseFloat(
          values.shift().replace(/\s/g, '').replace(',', '.')
        )
        const date = moment(values.join(' '), 'DD MMMM YYYY').toDate()

        Object.assign(entry, {
          periodStart: moment(entry.date).startOf('month').format('YYYY-MM-DD'),
          periodEnd: moment(entry.date).endOf('month').format('YYYY-MM-DD'),
          date,
          amount,
          vendor: 'Payfit',
          type: 'pay',
          employer: companyName,
          matchingCriterias: {
            labelRegex: `\\b${companyName}\\b`
          },
          isRefund: true
        })
        // Extract PDF data after 06-2022
      } else if (
        formatedText.match(/\(Virement\)[\s,0-9,+,-]+=\s+([0-9,]+)/) &&
        formatedText.match(/Datedepaiement\s*([0-9]{1,2}\/[0-9]{2}\/[0-9]{4})/)
      ) {
        const amountStg = formatedText.match(
          /\(Virement\)[\s,0-9,+,-]+=\s+([0-9,]+)/
        )[1]
        const amount = parseFloat(amountStg.replace(',', '.'))
        const dateStg = formatedText.match(
          /Datedepaiement\s*([0-9]{1,2}\/[0-9]{2}\/[0-9]{4})/
        )[1]
        const date = moment(dateStg, 'DD/MM/YYYY').toDate()

        Object.assign(entry, {
          periodStart: moment(entry.date).startOf('month').format('YYYY-MM-DD'),
          periodEnd: moment(entry.date).endOf('month').format('YYYY-MM-DD'),
          date,
          amount,
          vendor: 'Payfit',
          type: 'pay',
          employer: companyName,
          matchingCriterias: {
            labelRegex: `\\b${companyName}\\b`
          },
          isRefund: true
        })
      } else {
        throw new Error('no matched string in pdf')
      }
    }
  })
}

async function authenticate({ login, password }) {
  log('info', 'Login...')
  try {
    let body = await request.post({
      uri: 'https://api.payfit.com/auth/signin',
      body: {
        s: '',
        email: login,
        password: crypto
          .createHmac('sha256', password)
          .update('')
          .digest('hex'),
        isHashed: true,
        language: 'fr'
      }
    })
    if (body.isMultiFactorRequired) {
      log('info', '2FA detected')
      const code = await this.waitForTwoFaCode({ type: 'sms' })
      body = await request.post({
        uri: 'https://api.payfit.com/auth/signin',
        body: {
          s: '',
          email: login,
          password: crypto
            .createHmac('sha256', password)
            .update('')
            .digest('hex'),
          isHashed: true,
          multiFactorCode: code,
          language: 'fr'
        }
      })
    }
    return body
  } catch (err) {
    if (
      err.statusCode === 401 &&
      err.error &&
      err.error.error === 'invalid_password'
    ) {
      throw new Error(errors.LOGIN_FAILED)
    } else {
      throw err
    }
  }
}

async function fetchProfileInfo() {
  return request.post('https://api.payfit.com/hr/user/info')
}

async function fetchPayrolls({ employeeId, companyId }) {
  log('info', 'Fetching payrolls...')

  const { id } = await request.get(
    'https://api.payfit.com/files/category?name=payslip&country=FR'
  )

  return request.post('https://api.payfit.com/files/files', {
    body: {
      employeeIds: [employeeId],
      categoryIds: [id],
      companyIds: [companyId]
    }
  })
}

function convertPayrollsToCozy(payrolls, companyName) {
  log('info', 'Converting payrolls to cozy...')
  return payrolls.map(({ id, absoluteMonth }) => {
    const date = getDateFromAbsoluteMonth(absoluteMonth)
    const filename = `${companyName}_${format(date, 'yyyy_MM')}_${id.slice(
      -5
    )}.pdf`
    return {
      date: moment(date).format('YYYY-MM-DD'),
      fileurl: `https://api.payfit.com/files/file/${id}?attachment=1`,
      filename,
      // We keep both vendorID & vendorRef for historical purposes
      vendorId: id,
      vendorRef: id,
      recurrence: 'monthly',
      fileAttributes: {
        // Here the website doesn't provide the awaited datas anymore, but they can be found in the dowloaded pdf during saveBills().
        metadata: {
          contentAuthor: 'payfit.com',
          issueDate: new Date(),
          carbonCopy: true,
          qualification: Qualification.getByLabel('pay_sheet')
        }
      }
    }
  })
}

// extracted from Payfit front code
function getDateFromAbsoluteMonth(absoluteMonth) {
  return new Date(2015, absoluteMonth - 1)
}
