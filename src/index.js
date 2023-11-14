import { ContentScript } from 'cozy-clisk/dist/contentscript'
import { blobToBase64 } from 'cozy-clisk/dist/contentscript/utils'
import Minilog from '@cozy/minilog'
import waitFor from 'p-wait-for'
import { format } from 'date-fns'
import RequestInterceptor from './interceptor'
import pTimeout from 'p-timeout'
import ky from 'ky/umd'

const interceptor = new RequestInterceptor([
  {
    label: 'accountList',
    method: 'GET',
    url: 'auth/auth0/accounts',
    serialization: 'json'
  },
  {
    label: 'personnalInformations',
    method: 'GET',
    url: 'https://api.payfit.com/hr/user-settings/personal-information',
    serialization: 'json',
    exact: true
  },
  {
    label: 'userInfos',
    method: 'POST',
    url: 'https://api.payfit.com/hr/user/info',
    serialization: 'json',
    exact: true
  },
  {
    label: 'userSettings',
    method: 'GET',
    url: 'https://api.payfit.com/hr/user-settings',
    serialization: 'json',
    exact: true
  },
  {
    label: 'filesList',
    method: 'POST',
    url: 'https://api.payfit.com/files/files',
    serialization: 'json',
    exact: true
  }
])
interceptor.init()

const log = Minilog('ContentScript')
Minilog.enable('payfitCCC')

let FORCE_FETCH_ALL = false

const baseUrl = 'https://app.payfit.com/'
const payslipsUrl = `${baseUrl}payslips/`
const personalInfosUrl = `${baseUrl}settings/profile`

const burgerButtonSVGSelector =
  '[d="M2 15.5v2h20v-2H2zm0-5v2h20v-2H2zm0-5v2h20v-2H2z"]'

class PayfitContentScript extends ContentScript {
  async init(options) {
    await super.init(options)
    interceptor.on('response', response => {
      this.bridge.emit('workerEvent', {
        event: 'interceptedResponse',
        payload: response
      })
    })
  }
  waitForInterception(label, options = {}) {
    const timeout = options?.timeout ?? 30000
    const interceptionPromise = new Promise(resolve => {
      const listener = ({ event, payload }) => {
        if (event === 'interceptedResponse' && payload.label === label) {
          this.bridge.removeEventListener('workerEvent', listener)
          resolve(payload)
        }
      }
      this.bridge.addEventListener('workerEvent', listener)
    })

    return pTimeout(interceptionPromise, {
      milliseconds: timeout,
      message: `Timed out after waiting ${timeout}ms for interception of ${label}`
    })
  }
  addSubmitButtonListener() {
    const formElement = document.querySelector('form')
    const passwordButton = document.querySelector('._button-login-password')
    if (passwordButton) {
      formElement.addEventListener('submit', () => {
        const email = document.querySelector(
          '.ulp-authenticator-selector-text'
        )?.textContent
        const password = document.querySelector('#password')?.value
        this.bridge.emit('workerEvent', {
          event: 'loginSubmit',
          payload: { email, password }
        })
      })
    }
    const error = document.querySelector('#error-element-password')
    if (error) {
      this.bridge.emit('workerEvent', {
        event: 'loginError',
        payload: { msg: error.innerHTML }
      })
    }
  }

  onWorkerReady() {
    if (document.readyState !== 'loading') {
      this.addSubmitButtonListener.bind(this)()
    } else {
      window.addEventListener('DOMContentLoaded', () => {
        this.log('info', 'DOMLoaded')
        this.addSubmitButtonListener.bind(this)()
      })
    }
  }

  onWorkerEvent({ event, payload }) {
    if (event === 'loginSubmit') {
      this.log('info', 'received loginSubmit, blocking user interactions')
      this.blockWorkerInteractions()
      const { email, password } = payload || {}
      if (email && password) {
        this.log('info', 'Couple email/password found')
        this.store.userCredentials = { email, password }
      }
    } else if (event === 'loginError') {
      this.log(
        'info',
        'received loginError, unblocking user interactions: ' + payload?.msg
      )
      this.unblockWorkerInteractions()
    }
  }

  async PromiseRaceWithError(promises, msg) {
    try {
      this.log('debug', msg)
      await Promise.race(promises)
    } catch (err) {
      this.log('error', err.message)
      throw new Error(`${msg} failed to meet conditions`)
    }
  }

  async navigateToLoginForm() {
    this.log('info', '🤖 navigateToLoginForm')
    await this.goto(baseUrl)
    await this.PromiseRaceWithError(
      [
        this.waitForElementInWorker('#username'),
        this.waitForElementInWorker(burgerButtonSVGSelector),
        this.waitForElementInWorker('button[data-testid="accountButton"]')
      ],
      'navigateToLoginForm: waiting for default page load'
    )
  }

  async ensureAuthenticated({ account }) {
    this.log('info', '🤖 ensureAuthenticated')
    this.bridge.addEventListener('workerEvent', this.onWorkerEvent.bind(this))
    if (!account) {
      await this.ensureNotAuthenticated()
    }
    if (!(await this.isElementInWorker('#username'))) {
      await this.navigateToLoginForm()
    }
    const authenticated = await this.runInWorker('checkAuthenticated')
    if (!authenticated) {
      this.log('info', 'Not authenticated')
      const credentials = await this.getCredentials()
      if (credentials) {
        try {
          await this.autoLogin(credentials)
          this.log('info', 'autoLogin succesful')
        } catch (err) {
          this.log(
            'info',
            'Something went wrong with autoLogin: ' + err.message
          )
          await this.showLoginFormAndWaitForAuthentication()
        }
      } else {
        await this.showLoginFormAndWaitForAuthentication()
      }
    }
    if (await this.isElementInWorker('#code')) {
      this.log('info', 'Waiting for 2FA ...')
      this.unblockWorkerInteractions()
      await this.show2FAFormAndWaitForInput()
    }
    this.unblockWorkerInteractions()
    return true
  }

  async ensureNotAuthenticated() {
    this.log('info', '🤖 ensureNotAuthenticated')
    await this.navigateToLoginForm()
    const authenticated = await this.runInWorker('checkAuthenticated')
    if (!authenticated) {
      return true
    }

    this.log('info', 'Already logged in, logging out')
    await this.showAccountSwitchPage()
    await this.runInWorker('click', 'button > strong', {
      includesText: 'Déconnexion'
    })
    await this.waitForElementInWorker('#username')
    this.log('info', 'Logout OK')
  }

  async checkAuthenticated() {
    this.log('info', '🤖 checkAuthenticated')
    if (document.querySelector('#code')) {
      this.log('info', 'Login OK - 2FA needed, wait for user action')
      return true
    }
    if (document.querySelector('button[data-testid="accountButton"]')) {
      this.log('info', 'Login OK - Account selection needed')
      return true
    }
    if (document.querySelector(burgerButtonSVGSelector)) {
      this.log('info', 'Login OK')
      return true
    }
    return false
  }

  async showLoginFormAndWaitForAuthentication() {
    log.debug('showLoginFormAndWaitForAuthentication start')
    await this.setWorkerState({ visible: true })
    await this.runInWorkerUntilTrue({
      method: 'waitForAuthenticated'
    })
    await this.setWorkerState({ visible: false })
  }

  async show2FAFormAndWaitForInput() {
    log.debug('show2FAFormAndWaitForInput start')
    await this.setWorkerState({ visible: true })
    await this.runInWorkerUntilTrue({ method: 'waitFor2FA' })
    await this.setWorkerState({ visible: false })
  }

  async autoLogin(credentials) {
    this.log('info', '📍️ autoLogin starts')
    const emailInputSelector = '#username'
    const passwordInputSelector = '#password'
    const emailNextButtonSelector = '._button-login-id'
    const passwordSubmitButtonSelector = '._button-login-password'
    await this.waitForElementInWorker(emailInputSelector)
    this.log('debug', 'Fill email field')
    await this.runInWorker('fillText', emailInputSelector, credentials.email)
    await this.runInWorker('click', emailNextButtonSelector)

    this.log('debug', 'Wait for password field')
    await this.waitForElementInWorker(passwordInputSelector)

    this.log('debug', 'Fill password field')
    await this.runInWorker(
      'fillText',
      passwordInputSelector,
      credentials.password
    )
    await this.runInWorker('click', passwordSubmitButtonSelector)
    await this.PromiseRaceWithError(
      [
        this.waitForElementInWorker(burgerButtonSVGSelector),
        this.waitForElementInWorker('#code'),
        this.waitForElementInWorker('button[data-testid="accountButton"]')
      ],
      'autoLogin: waiting for page load after submit'
    )
  }

  async showAccountSwitchPage() {
    // force the account choice page
    await this.evaluateInWorker(() => window.localStorage.clear())
    await this.goto(baseUrl)
    await this.evaluateInWorker(() => window.location.reload()) // refresh the current page after localStorage update
    const accountList = await this.waitForInterception('accountList')
    return accountList
  }

  async getUserDataFromWebsite() {
    this.log('info', '🤖 getUserDataFromWebsite')

    const accountList = await this.showAccountSwitchPage()
    this.store.accountList = accountList.response

    // find the user email in store or saved credentials
    const sourceAccountIdentifier =
      this.store?.userCredentials?.email || (await this.getCredentials())?.email
    if (!sourceAccountIdentifier) {
      throw new Error('Could not find any sourceAccountIdentifier')
    }

    return {
      sourceAccountIdentifier
    }
  }

  async fetch(context) {
    this.log('info', '🤖 fetch')
    if (this.store && this.store.userCredentials) {
      this.log('info', 'Saving credentials ...')
      await this.saveCredentials(this.store.userCredentials)
    }

    const { trigger } = context
    // force fetch all data (the long way) when last trigger execution is older than 30 days
    // or when the last job was an error
    const isLastJobError =
      trigger.current_state?.last_failure > trigger.current_state?.last_success
    const hasLastExecution = Boolean(trigger.current_state?.last_execution)
    const distanceInDays = getDateDistanceInDays(
      trigger.current_state?.last_execution
    )
    if (distanceInDays >= 30 || !hasLastExecution || isLastJobError) {
      this.log('info', `isLastJobError: ${isLastJobError}`)
      this.log('info', `distanceInDays: ${distanceInDays}`)
      this.log('info', `hasLastExecution: ${hasLastExecution}`)
      FORCE_FETCH_ALL = true
    }
    this.log('info', `FORCE_FETCH_ALL: ${FORCE_FETCH_ALL}`)

    // sort accountList to have the latest contract first
    const getContractStart = account =>
      account.companyInfo.loginDescription
        .split(':')
        .pop()
        .trim()
        .split('/')
        .reverse()
        .join('/')
    this.store.accountList
      .filter(account => account?.account?.userRole !== 'admin') // ignore manager accounts (nothing to fetch)
      .sort(
        (a, b) => (getContractStart(a) < getContractStart(b) ? 1 : -1) // with fetch latest contract first
      )

    if (!FORCE_FETCH_ALL) {
      // only fetch the last contract in date
      this.store.accountList = this.store.accountList.slice(0, 1)
    }
    for (const account of this.store.accountList) {
      // select this account as the current account
      await this.evaluateInWorker(
        account => window.localStorage.setItem('accountChoice', account),
        JSON.stringify(account)
      )
      await this.goto(baseUrl)
      await this.evaluateInWorker(() => window.location.reload()) // refresh the current page after localStorage update
      const userInfos = await this.waitForInterception('userInfos')
      await this.fetchPayslips({
        context,
        account,
        userInfos,
        FORCE_FETCH_ALL
      })
    }

    if (FORCE_FETCH_ALL) {
      // save identity only when FORCE_FETCH_ALL === true to favor fast execution as much as possible
      const [userSettings, personnalInformations] = await Promise.all([
        this.waitForInterception('userSettings'),
        this.waitForInterception('personnalInformations'),
        this.goto(personalInfosUrl)
      ])
      const parsedIdentity = this.parseIdentity({
        userSettings,
        personnalInformations
      })
      await this.saveIdentity({ contact: parsedIdentity })
    }
  }

  async downloadFileInWorker(entry) {
    // overload ContentScript.downloadFileInWorker to be able to get the token and to run double
    // fetch request necessary to finally get the file
    this.log('debug', 'downloading file in worker')

    const token = window.payFitKonnectorToken

    const nextUrlDocument = await ky
      .get(entry.fileurl, {
        headers: {
          Authorization: 'Bearer ' + token
        }
      })
      .json()

    const blob = await ky
      .get('https://api.payfit.com/files' + nextUrlDocument.url, {
        headers: {
          Authorization: 'Bearer ' + token
        }
      })
      .blob()
    entry.dataUri = await blobToBase64(blob)
    return entry.dataUri
  }

  async fetchPayslips({ context, account, userInfos, FORCE_FETCH_ALL }) {
    this.log('info', '📍️ fetchPayslips starts')
    const [filesList] = await Promise.all([
      this.waitForInterception('filesList'),
      this.goto(payslipsUrl)
    ])
    const token = filesList.requestHeaders.Authorization.split(' ').pop()
    await this.evaluateInWorker(
      token => (window.payFitKonnectorToken = token),
      token
    )
    const companyName = account.companyInfo.name
    const fileDocuments = filesList.response
      .sort((a, b) => (a.absoluteMonth < b.absoluteMonth ? 1 : -1)) // will fetch newest payslips first
      .map(fileDocument => {
        const vendorId = fileDocument.id
        const date = getDateFromAbsoluteMonth(fileDocument.absoluteMonth)
        const filename = `${companyName}_${format(
          date,
          'yyyy_MM'
        )}_${vendorId.slice(-5)}.pdf`
        return {
          date: format(date, 'yyyy-MM-dd'),
          vendorId: fileDocument.id,
          vendorRef: vendorId,
          companyName,
          filename,
          recurrence: 'monthly',
          fileurl: `https://api.payfit.com/files/file/${fileDocument.id}/presigned-url?attachment=1`,
          fileAttributes: {
            metadata: {
              contentAuthor: 'payfit.com',
              issueDate: new Date(fileDocument.createdAt),
              carbonCopy: true
            }
          }
        }
      })

    const subPath = `${companyName} - ${
      userInfos.response.contractName
    } - ${userInfos.response.contractStartDate.split('/').reverse().join('-')}`
    // only select the 3 last documents when FORCE_FETCH_ALL is false
    const selectedDocuments = FORCE_FETCH_ALL
      ? fileDocuments
      : fileDocuments.slice(0, 3)
    await this.saveFiles(selectedDocuments, {
      context,
      fileIdAttributes: ['vendorId'],
      contentType: 'application/pdf',
      qualificationLabel: 'pay_sheet',
      subPath
    })
  }

  async waitFor2FA() {
    this.log('info', 'waitFor2FA starts')
    await waitFor(
      () => {
        if (document.querySelector(burgerButtonSVGSelector)) {
          this.log('info', '2FA OK - Land on home')
          return true
        } else if (
          document.querySelector('button[data-testid="accountButton"]')
        ) {
          this.log('info', '2FA OK - Land on accounts selection')
          return true
        }
        return false
      },
      {
        interval: 1000,
        timeout: Infinity
      }
    )
    return true
  }

  parseIdentity({ userSettings, personnalInformations }) {
    this.log('info', '📍️ parseIdentity starts')
    const infos = personnalInformations.response.variables
    const emails = userSettings.response.userEmails
    const identity = {
      name: {
        givenName: infos.firstName,
        familyName: infos.birthName
      },
      address: [],
      email: [],
      phone: []
    }
    if (infos.phoneNumber) {
      this.log('info', 'phoneNumber is defined, saving it')
      identity.phone.push({
        number: infos.phoneNumber,
        type: this.determinePhoneType(infos.phoneNumber)
      })
    } else {
      this.log(
        'info',
        'phoneNumber is null, deleting phone entry from identity'
      )
      delete identity.phone
    }
    const foundAddress = this.getAddress(infos)
    for (const email of emails) {
      if (email.primary) {
        identity.email.push({ address: email.address })
      }
    }
    identity.address.push(foundAddress)
    return identity
  }

  determinePhoneType(phoneNumber) {
    this.log('info', '📍️ determinePhoneType starts')
    if (phoneNumber.startsWith('06') || phoneNumber.startsWith('07')) {
      return 'mobile'
    } else {
      return 'home'
    }
  }

  getAddress(infos) {
    this.log('info', '📍️ getAddress starts')
    let constructedAddress = ''
    const address = {}
    if (
      infos.addressNumber !== null &&
      !infos.address.includes(infos.addressNumber)
    ) {
      constructedAddress += infos.addressNumber
      address.streetNumer = infos.addressNumber
    } else {
      constructedAddress += infos.address
      address.street = infos.address
    }

    if (
      infos.addressStreetType !== null &&
      !infos.address.includes(infos.addressStreetType)
    ) {
      constructedAddress += ` ${infos.addressStreetType}`
      address.streetType = infos.addressStreetType
    }

    if (infos.additionalAddress !== null) {
      constructedAddress += ` ${infos.additionalAddress}`
      address.complement = infos.additionalAddress
    }

    constructedAddress += ` ${infos.postcode} ${infos.city} ${infos.country}`
    address.city = infos.city
    address.postCode = infos.postcode
    address.country = infos.country
    address.formattedAddress = constructedAddress

    return address
  }
}

function getDateFromAbsoluteMonth(absoluteMonth) {
  return new Date(2015, absoluteMonth - 1)
}

const connector = new PayfitContentScript()
connector
  .init({
    additionalExposedMethodsNames: ['waitFor2FA']
  })
  .catch(err => {
    log.warn(err)
  })

function getDateDistanceInDays(dateString) {
  const distanceMs = Date.now() - new Date(dateString).getTime()
  const days = 1000 * 60 * 60 * 24

  return Math.floor(distanceMs / days)
}
