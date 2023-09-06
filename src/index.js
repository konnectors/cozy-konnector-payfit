import { ContentScript } from 'cozy-clisk/dist/contentscript'
import Minilog from '@cozy/minilog'
import waitFor from 'p-wait-for'
import { format } from 'date-fns'
const log = Minilog('ContentScript')
Minilog.enable('payfitCCC')

const baseUrl = 'https://app.payfit.com/'
const personalInfosUrl = `${baseUrl}settings/profile`

let personalInfos = []
let userSettings = []
let bills = []
let billsHrefs = []

// We need to type of interceptions, the fetch and the Xhr as requests for personnal informations are done with fetch
// but the payslips request is done with XMLHttpRequest

const fetchOriginal = window.fetch
window.fetch = async (...args) => {
  const response = await fetchOriginal(...args)
  if (
    typeof args[0] === 'string' &&
    args[0] === 'https://api.payfit.com/hr/user-settings/personal-information'
  ) {
    await response
      .clone()
      .json()
      .then(body => {
        personalInfos.push(body)
        return response
      })
      .catch(err => {
        // eslint-disable-next-line no-console
        console.log(err)
        return response
      })
  }
  if (
    typeof args[0] === 'string' &&
    args[0] === 'https://api.payfit.com/hr/user-settings'
  ) {
    await response
      .clone()
      .json()
      .then(body => {
        userSettings.push(body)
        return response
      })
      .catch(err => {
        // eslint-disable-next-line no-console
        console.log(err)
        return response
      })
  }
  return response
}

var openProxied = window.XMLHttpRequest.prototype.open
window.XMLHttpRequest.prototype.open = function () {
  var originalResponse = this
  if (arguments[1] === 'https://api.payfit.com/files/files') {
    originalResponse.addEventListener('readystatechange', function () {
      if (originalResponse.readyState === 4) {
        const jsonBills = JSON.parse(originalResponse.responseText)
        bills.push(jsonBills)
      }
    })
    return openProxied.apply(this, [].slice.call(arguments))
  }
  if (
    typeof arguments[1] === 'string' &&
    arguments[1].includes('/presigned-url?attachment=1')
  ) {
    originalResponse.addEventListener('readystatechange', function () {
      if (originalResponse.readyState === 4) {
        const jsonBillHref = JSON.parse(originalResponse.responseText).url
        billsHrefs.push(jsonBillHref)
      }
    })
    return openProxied.apply(this, [].slice.call(arguments))
  } else {
    return openProxied.apply(this, [].slice.call(arguments))
  }
}

class PayfitContentScript extends ContentScript {
  addSubmitButtonListener() {
    // this.log('info', '🤖 addSubmitButtonListener')
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
    const error = document.querySelector('.error')
    if (error) {
      this.bridge.emit('workerEvent', {
        event: 'loginError',
        payload: { msg: error.innerHTML }
      })
    }
  }

  onWorkerReady() {
    this.log('info', '🤖 onWorkerReady')
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
    this.log('info', '🤖 onWorkerEvent')
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

  async navigateToLoginForm() {
    this.log('info', '🤖 navigateToLoginForm')
    await this.goto(baseUrl)
    await Promise.race([
      this.waitForElementInWorker('#username'),
      this.waitForElementInWorker('div[data-testid="userInfoSection"]')
    ])
  }

  async ensureAuthenticated({ account }) {
    // Using a desktop userAgent is mandatory to have access to the user's personnal data
    await this.bridge.call(
      'setUserAgent',
      'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:94.0) Gecko/20100101 Firefox/94.0'
    )
    this.bridge.addEventListener('workerEvent', this.onWorkerEvent.bind(this))
    this.log('info', '🤖 ensureAuthenticated')
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
        } catch {
          this.log(
            'info',
            'Something went wrong with autoLogin, letting user log in'
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
    } else {
      this.log('info', 'Already logged in, logging out')
      await this.clickAndWait(
        'div[data-testid="mobile-menu-toggle"]',
        'div[data-testid="accountDropdown"] > button'
      )
      await this.runInWorker(
        'click',
        'div[data-testid="accountDropdown"] > button'
      )
      await this.waitForElementInWorker('div[role="menu"]')
      const optionId = await this.evaluateInWorker(function getMenuId() {
        const menuElement = document.querySelector('div[role="menu"]')
        const menuId = menuElement.getAttribute('id')
        const menuOptionsElements = menuElement.querySelectorAll(
          `div[id*="${menuId}"]`
        )
        for (let i = 0; i < menuOptionsElements.length; i++) {
          const optionElement = menuOptionsElements[i].querySelector('span')
          const option = optionElement.textContent
          const optionElementId = menuOptionsElements[i].getAttribute('id')
          if (option === 'Me déconnecter') {
            return optionElementId
          }
        }
        throw new Error(
          'No options matched "Me déconnecter" expectations, check the code'
        )
      })
      await this.clickAndWait(`#${optionId}`, '#username')
      this.log('info', 'Logout OK')
    }
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
    if (document.querySelector('div[data-testid="userInfoSection"]')) {
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
    await this.Promise.race([
      this.waitForElementInWorker('div[data-testid="userInfoSection"]'),
      this.waitForElementInWorker('#code'),
      this.waitForElementInWorker('button[data-testid="accountButton"]')
    ])
  }

  async getUserDataFromWebsite() {
    this.log('info', '🤖 getUserDataFromWebsite')
    if (await this.isElementInWorker('button[data-testid="accountButton"]')) {
      await this.runInWorker('selectClosestToDateContract')
      this.log('info', `Found ${this.store.numberOfContracts} contracts`)
    }
    await Promise.all([
      this.waitForElementInWorker('div[data-testid="userInfoSection"]'),
      this.waitForElementInWorker(
        'div[data-testid="dashboardBulletsContractStart"]'
      )
    ])
    await this.runInWorker('getContractInfos')
    await this.goto(personalInfosUrl)
    await this.waitForElementInWorker(
      'button[data-testid="changePersonalInformationButton"]'
    )
    await this.runInWorkerUntilTrue({
      method: 'checkInterception',
      args: [{ type: 'identity' }]
    })
    await this.runInWorker('getIdentity')
    if (this.store.userIdentity.email[0]?.address) {
      return {
        sourceAccountIdentifier: this.store.userIdentity.email[0].address
      }
    } else {
      throw new Error('No email found for identity')
    }
  }

  async fetch(context) {
    this.log('info', '🤖 fetch')
    if (this.store && this.store.userCredentials) {
      this.log('info', 'Saving credentials ...')
      await this.saveCredentials(this.store.userCredentials)
    }
    if (this.store.userIdentity) {
      this.log('info', 'Saving identity ...')
      await this.saveIdentity({ contact: this.store.userIdentity })
    }
    const foundNumberOfContracts = this.store.numberOfContracts
      ? this.store.numberOfContracts
      : 1
    for (let i = 0; i < foundNumberOfContracts; i++) {
      this.log(
        'info',
        `Fetching ${i + 1}/${foundNumberOfContracts} contract ...`
      )
      await this.fetchPayslips({
        context,
        fetchedDates: this.store.fetchedDates,
        i
      })
      if (foundNumberOfContracts > 1) {
        await this.navigateToNextContract()
      }
    }
  }

  async fetchPayslips({ context, fetchedDatesArray, i }) {
    this.log('info', '📍️ fetchPayslips starts')
    await this.navigateToPayrollsPage()
    const numberOfBills = await this.evaluateInWorker(
      function getNumberOfBills() {
        const billsElements = document.querySelectorAll(
          'div[data-testid*="payslip-"] > div'
        )
        for (const billElement of billsElements) {
          billElement.click()
        }
        return billsElements.length
      }
    )
    await this.runInWorkerUntilTrue({
      method: 'checkInterception',
      args: [{ type: 'bills', number: numberOfBills }]
    })
    const allBills = await this.runInWorker('getBills')
    let subPath = await this.determineSubPath(fetchedDatesArray, i)
    // We cannot use saveBills yet as we need an amount that used to be scraped in the downloaded pdf and added afterward
    // And this feature is not implemented in cozy-clisk yet
    // await this.saveBills(allBills, {
    //   context,
    //   fileIdAttributes: ['vendorId'],
    //   processPdf: (entry, text) => {
    //     const formatedText = text.split('\n').join(' ').replace(/ /g, '')

    //     // Extract PDF data before 06-2022
    //     if (
    //       formatedText.match(
    //         /VIREMENT([0-9,]*)DATEDEPAIEMENT([0-9]{2})(JANVIER|FÉVRIER|MARS|AVRIL|MAI|JUIN|JUILLET|AOÛT|SEPTEMBRE|OCTOBRE|NOVEMBRE|DÉCEMBRE)([0-9]{4})/
    //       )
    //     ) {
    //       const matchedStrings = text
    //         .split('\n')
    //         .join(' ')
    //         .replace(/ /g, '')
    //         .match(
    //           /VIREMENT([0-9,]*)DATEDEPAIEMENT([0-9]{2})(JANVIER|FÉVRIER|MARS|AVRIL|MAI|JUIN|JUILLET|AOÛT|SEPTEMBRE|OCTOBRE|NOVEMBRE|DÉCEMBRE)([0-9]{4})/
    //         )
    //       const values = matchedStrings
    //         .slice(1)
    //         .map(data => data.trim().replace(/\s\s+/g, ' '))
    //       const amount = parseFloat(
    //         values.shift().replace(/\s/g, '').replace(',', '.')
    //       )
    //       const date = parse(values.join(' '), 'dd MMMM yyyy', new Date())
    //       const companyName = entry.companyName

    //       Object.assign(entry, {
    //         periodStart: format(startOfMonth(entry.date), 'yyyy-MM-dd'),
    //         periodEnd: format(endOfMonth(entry.date), 'yyyy-MM-dd'),
    //         date,
    //         amount,
    //         vendor: 'Payfit',
    //         type: 'pay',
    //         employer: companyName,
    //         matchingCriterias: {
    //           labelRegex: `\\b${companyName}\\b`
    //         },
    //         isRefund: true
    //       })
    //       // Extract PDF data after 06-2022
    //     } else if (
    //       formatedText.match(/\(Virement\)[\s,0-9,+,-]+=\s+([0-9,]+)/) &&
    //       formatedText.match(
    //         /Datedepaiement\s*([0-9]{1,2}\/[0-9]{2}\/[0-9]{4})/
    //       )
    //     ) {
    //       const amountStg = formatedText.match(
    //         /\(Virement\)[\s,0-9,+,-]+=\s+([0-9,]+)/
    //       )[1]
    //       const amount = parseFloat(amountStg.replace(',', '.'))
    //       const dateStg = formatedText.match(
    //         /Datedepaiement\s*([0-9]{1,2}\/[0-9]{2}\/[0-9]{4})/
    //       )[1]
    //       const date = parse(dateStg, 'dd/MM/yyyy', new Date())
    //       const companyName = entry.companyName

    //       Object.assign(entry, {
    //         periodStart: format(startOfMonth(entry.date), 'yyyy-MM-dd'),
    //         periodEnd: format(endOfMonth(entry.date), 'yyyy-MM-dd'),
    //         date,
    //         amount,
    //         vendor: 'Payfit',
    //         type: 'pay',
    //         employer: companyName,
    //         matchingCriterias: {
    //           labelRegex: `\\b${companyName}\\b`
    //         },
    //         isRefund: true
    //       })
    //     } else {
    //       throw new Error('no matched string in pdf')
    //     }
    //   },
    //   shouldReplaceFile: function (newBill, dbEntry) {
    //     const result =
    //       newBill.metadata.issueDate !==
    //       dbEntry.fileAttributes.metadata.issueDate
    //     return result
    //   }
    // })
    await this.saveFiles(allBills, {
      context,
      fileIdAttributes: ['vendorId'],
      contentType: 'application/pdf',
      qualificationLabel: 'pay_sheet',
      subPath
    })
  }

  determineSubPath(fetchedDatesArray, i) {
    this.log('info', '📍️ determineSubPath starts')
    let subPath = `${this.store.companyName} - ${this.store.contractsInfos[i].type}`
    if (!fetchedDatesArray) {
      subPath = `${subPath} - ${this.store.contractsInfos[i].startDate}`
    } else {
      subPath = `${subPath} - ${fetchedDatesArray[i]}`
    }
    if (this.store.contractsInfos[i].endDate) {
      subPath = `${subPath} → ${this.store.contractsInfos[i].endDate}`
    }
    return subPath
  }

  async navigateToPayrollsPage() {
    this.log('info', '📍️ navigateToPayrollsPage starts')
    await this.clickAndWait(
      'div[data-testid="mobile-menu-toggle"]',
      'a[data-testid="menu-link:/payslips"]'
    )
    await this.clickAndWait(
      'a[data-testid="menu-link:/payslips"]',
      'div[data-testid*="payslip-"]'
    )
  }

  async navigateToNextContract() {
    this.log('info', '📍️ navigateToNextContract starts')
    await this.clickAndWait(
      'div[data-testid="mobile-menu-toggle"]',
      'div[data-testid="accountDropdown"] > button'
    )
    await this.runInWorker(
      'click',
      'div[data-testid="accountDropdown"] > button'
    )
    await this.waitForElementInWorker('div[role="menu"]')
    const optionId = await this.evaluateInWorker(function getMenuId() {
      const menuElement = document.querySelector('div[role="menu"]')
      const menuId = menuElement.getAttribute('id')
      const menuOptionsElements = menuElement.querySelectorAll(
        `div[id*="${menuId}"]`
      )
      for (let i = 0; i < menuOptionsElements.length; i++) {
        const optionElement = menuOptionsElements[i].querySelector('span')
        const option = optionElement.textContent
        const optionElementId = menuOptionsElements[i].getAttribute('id')
        if (option === 'Changer de compte') {
          return optionElementId
        }
      }
      throw new Error(
        'No options matched "Changer de compte" expectations, check the code'
      )
    })
    await this.clickAndWait(
      `#${optionId}`,
      'button[data-testid="accountButton"]'
    )
    const datesArray = this.store.fetchedDates
    const numberOfContracts = this.store.numberOfContracts
    const lastContract = await this.runInWorker(
      'determineContractToSelect',
      datesArray,
      numberOfContracts
    )
    if (lastContract) {
      return true
    }
    await this.waitForElementInWorker('div[data-testid="userInfoSection"]')
    const contractInfos = this.store.contractsInfos
    await this.runInWorker('getContractInfos', contractInfos)
  }

  async waitFor2FA() {
    this.log('info', 'waitFor2FA starts')
    await waitFor(
      () => {
        if (document.querySelector('div[data-testid="userInfoSection"]')) {
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

  async selectClosestToDateContract() {
    this.log('info', 'selectClosestToDateContract starts')
    const numberOfContracts = this.getNumberOfContracts()
    this.log('info', 'Sending number of contracts to Pilot')
    const contractElements = document.querySelectorAll(
      'button[data-testid="accountButton"]'
    )
    const closestDate = await this.determineClosestToDate(contractElements)
    await this.sendToPilot({
      numberOfContracts,
      fetchedDates: [closestDate.date]
    })
    contractElements[closestDate.index].click()
  }

  determineClosestToDate(elements) {
    this.log('info', '📍️ determineClosestToDate starts')
    const foundDates = []
    for (let i = 0; i < elements.length; i++) {
      const foundDate = elements[i]
        .querySelector('span')
        .textContent.split(':')[1]
        .trim()
      foundDates.push(foundDate)
    }
    const actualDate = new Date()
    const diffMin = foundDates.reduce(
      (min, date, index) => {
        const dateCourante = new Date(date)
        const diff = Math.abs(dateCourante - actualDate)
        return diff < min.diff ? { diff, index, date } : min
      },
      { diff: Infinity, index: -1 }
    )
    return diffMin
  }

  getNumberOfContracts() {
    this.log('info', 'getNumberOfContracts starts')
    const numberOfContracts = document.querySelectorAll(
      'button[data-testid="accountButton"]'
    ).length
    return numberOfContracts
  }

  async getContractInfos(contractsInfos) {
    this.log('info', '📍️ getContractInfos starts')
    const allContractsInfos = []
    if (contractsInfos) {
      for (const contractInfos of contractsInfos)
        allContractsInfos.push(contractInfos)
    }
    const startDate = document
      .querySelector('div[data-testid="dashboardBulletsContractStart"]')
      .textContent.split('contrat')[1]
      .replace(/\//g, '-')
    const endDate = document
      .querySelector('div[data-testid="dashboardBulletsContractEnd"]')
      ?.textContent.split('contrat')[1]
      .replace(/\//g, '-')
    const type = document
      .querySelector('div[data-testid="dashboardBulletsContractType"]')
      .textContent.split('contrat')[1]
    const contract = {
      startDate,
      type
    }
    if (endDate) {
      contract.endDate = endDate
    }
    allContractsInfos.push(contract)
    await this.sendToPilot({ contractsInfos: allContractsInfos })
  }

  async checkInterception(args) {
    this.log('info', `📍️ checkInterception for ${args.type} starts`)
    await waitFor(
      () => {
        if (args.type === 'identity') {
          if (personalInfos.length > 0 && userSettings.length > 0) {
            this.log('info', 'personalInfos interception OK')
            return true
          }
          return false
        }
        if (args.type === 'bills') {
          if (bills.length > 0 && billsHrefs.length === args.number) {
            this.log('info', 'bills interception OK')
            return true
          }
          return false
        }
      },
      {
        interval: 1000,
        timeout: 30 * 1000
      }
    )
    return true
  }

  async getIdentity() {
    this.log('info', '📍️ getIdentity starts')
    const infos = personalInfos[0].variables
    const emails = userSettings[0].userEmails
    const userIdentity = {
      name: {
        givenName: infos.firstName,
        familyName: infos.birthName
      },
      address: [],
      email: [],
      phone: [
        {
          number: infos.phoneNumber,
          type: this.determinePhoneType(infos.phoneNumber)
        }
      ]
    }
    const foundAddress = this.getAddress(infos)
    for (const email of emails) {
      if (email.primary) {
        userIdentity.email.push({ address: email.address })
      }
    }
    userIdentity.address.push(foundAddress)
    await this.sendToPilot({ userIdentity })
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

  async getBills() {
    this.log('info', '📍️ getBills starts')
    const billsInfos = bills[0]
    const computedBills = []
    const accountChoice = JSON.parse(
      window.localStorage.getItem('accountChoice')
    )
    const companyName = accountChoice.companyInfo.name
    await this.sendToPilot({ companyName })
    for (const bill of billsInfos) {
      const billId = bill.id
      const issueDate = bill.createdAt
      const date = getDateFromAbsoluteMonth(bill.absoluteMonth)
      const filename = `${companyName}_${format(
        date,
        'yyyy_MM'
      )}_${billId.slice(-5)}.pdf`
      const computedBill = {
        date: format(date, 'yyyy-MM-dd'),
        filename,
        // This is supposed to be added to the data  by the "processPdf" function in saveBills opt.
        // after scraping the associated PDF. But for now, this feature is not handled by cozy-clisk.
        // For the saveBills to work properly we need to add an amount and a vendor to the bill at least
        // amount: 2000,
        // vendor: 'payfit.fr',
        companyName,
        // We keep both vendorID & vendorRef for historical purposes
        vendorId: billId,
        vendorRef: billId,
        recurrence: 'monthly',
        fileAttributes: {
          metadata: {
            contentAuthor: 'payfit.com',
            issueDate: new Date(issueDate),
            carbonCopy: true
          }
        }
      }
      const downloadHref = await this.getDownloadHref(billId)
      computedBill.fileurl = `https://api.payfit.com/files${downloadHref}`
      computedBills.push(computedBill)
    }
    return computedBills
  }

  async getDownloadHref(id) {
    this.log('info', '📍️ getDownloadHref starts')
    for (let i = 0; i < billsHrefs.length; i++) {
      if (billsHrefs[i].includes(id)) {
        return billsHrefs[i]
      }
    }
    throw new Error('No href found with this is, check the code')

    // Keeping this code around if we find a way to get the Bearer token later
    // const urlResp = await this.window
    //   .fetch(
    //     `https://api.payfit.com/files/file/${id}/presigned-url?attachment=1`
    //   )
    //   .then(response => {
    //     if (!response.ok) {
    //       throw new Error('Something went wrong when fetching a download URL')
    //     }
    //     return response.json()
    //   })
    // return urlResp.url
  }

  async determineContractToSelect(fetchedDatesArray, numberOfContracts) {
    this.log('info', '📍️ determineContractToSelect starts')
    const contractButtons = document.querySelectorAll(
      'button[data-testid="accountButton"]'
    )
    const datesArray = [...fetchedDatesArray]
    let numberOfFetchedContracts = 0
    for (let i = 0; i < contractButtons.length; i++) {
      const contractDate = contractButtons[i]
        .querySelector('span')
        .textContent.split(':')[1]
        .trim()
      const index = fetchedDatesArray.findIndex(
        element => element === contractDate
      )
      if (index === -1) {
        this.log('info', 'This contract could be fetch')
        datesArray.push(contractDate)
        contractButtons[i].click()
        await this.sendToPilot({ fetchedDates: datesArray })
        break
      } else {
        this.log('info', 'This contract has already been fetched, continue')
        numberOfFetchedContracts++
      }
    }
    if (numberOfFetchedContracts === numberOfContracts) {
      this.log('info', 'Last contract fetched, finishing ...')
      return true
    }
    return false
  }
}

function getDateFromAbsoluteMonth(absoluteMonth) {
  return new Date(2015, absoluteMonth - 1)
}

const connector = new PayfitContentScript()
connector
  .init({
    additionalExposedMethodsNames: [
      'waitFor2FA',
      'selectClosestToDateContract',
      'getIdentity',
      'checkInterception',
      'getBills',
      'determineContractToSelect',
      'getContractInfos'
    ]
  })
  .catch(err => {
    log.warn(err)
  })
