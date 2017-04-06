import computeManagementClient = require("./azure-rest/azure-arm-compute");
import util = require("util");
import tl = require("vsts-task-lib/task");
import azure_utils = require("./AzureUtil");
import deployAzureRG = require("../models/DeployAzureRG");
import az = require("./azure-rest/azureModels");
import utils = require("./Utils");

export class MachineGroupExtensionHelper {
    private taskParameters: deployAzureRG.AzureRGTaskParameters;
    private azureUtils: azure_utils.AzureUtil;
    private computeClient: computeManagementClient.ComputeManagementClient;
    private publisher = "Microsoft.VisualStudio.Services";
    private extensionType = "Microsoft.Compute/virtualMachines/extensions";
    private mgExtensionNameWindows = "TeamServicesAgent";
    private vmExtensionTypeWindows = "TeamServicesAgent";
    private mgExtensionNameLinux = "TeamServicesAgentLinux";
    private vmExtensionTypeLinux = "TeamServicesAgentLinux";
    //Whenever major version is modified, modify the task version accordingly.
    private version = "1.0";

    constructor(taskParameters: deployAzureRG.AzureRGTaskParameters) {
        this.taskParameters = taskParameters;
        this.computeClient = new computeManagementClient.ComputeManagementClient(this.taskParameters.credentials, this.taskParameters.subscriptionId);
        this.azureUtils = new azure_utils.AzureUtil(this.taskParameters, this.computeClient);
    }

    public async addExtensionOnResourceGroup() {
        console.log(tl.loc("AddingMGAgentOnVMs"));
        var listOfVms: az.VM[] = await this.azureUtils.getVMDetails();
        var extensionAddedOnVMsPromises: Promise<any>[] = [];
        for (var vm of listOfVms) {
            extensionAddedOnVMsPromises.push(this.addExtensionOnSingleVM(vm));
        }
        await Promise.all(extensionAddedOnVMsPromises);
        if (listOfVms.length > 0) {
            console.log(tl.loc("MGAgentAddedOnAllVMs"));
        }
    }

    public async deleteExtensionFromResourceGroup(): Promise<void> {
        console.log(tl.loc("DeletingMGAgentOnVMs"));
        var listOfVms: az.VM[] = await this.azureUtils.getVMDetails();
        var deleteExtensionFromVmPromises: Promise<any>[] = [];
        for (var vm of listOfVms) {
            deleteExtensionFromVmPromises.push(this.deleteExtensionFromSingleVM(vm));
        }
        await Promise.all(deleteExtensionFromVmPromises);
        if (listOfVms.length > 0) {
            console.log(tl.loc("MGAgentDeletedFromAllVMs"));
        }
    }

    public deleteExtensionFromSingleVM(vm: az.VM): Promise<any> {
        return new Promise((resolve, reject) => {
            var vmName = vm["name"];
            var extensionParameters = this.formExtensionParameters(vm, "delete");
            var extensionName = extensionParameters["extensionName"];
            console.log(tl.loc("DeleteExtension", extensionName, vmName));
            this.computeClient.virtualMachineExtensions.deleteMethod(this.taskParameters.resourceGroupName, vmName, extensionName, (error, result, request, response) => {
                if (error) {
                    tl.warning(tl.loc("DeleteAgentManually", vmName, this.taskParameters.machineGroupName));
                    return reject(tl.loc("DeletionFailed", vmName, utils.getError(error)));
                }
                console.log(tl.loc("DeletionSucceeded", vmName));
                resolve();
            });
        });
    }

    private async addExtensionOnSingleVM(vm: az.VM) {
        var vmName = vm.name;
        var operation = "add";
        var vmWithInstanceView: az.VM = await this.getVmWithInstanceView(this.taskParameters.resourceGroupName, vmName, { expand: 'instanceView' });
        var vmPowerState = this.getVMPowerState(vmWithInstanceView);
        if (vmPowerState === "deallocated") {
            await this.startVirtualMachine(vmName);
            vmPowerState = "running";
        }
        if (vmPowerState === "running") {
            await this.addExtensionOnRunningVm(vm);
        }
        else {
            throw new Error(tl.loc("VMTransitioningSkipExtensionAddition", vmName));
        }
    }

    private getVMPowerState(vm: az.VM): string {
        var statuses = vm.properties.instanceView.statuses;
        for (var status of statuses) {
            if (status.code) {
                var properties = status.code.split("/");
                if (properties.length > 1 && properties[0] === "PowerState") {
                    return properties[1];
                }
            }
        }
        return null;
    }

    private getVmWithInstanceView(resourceGroupName, vmName, object): Promise<az.VM> {
        return new Promise((resolve, reject) => {
            var getVmWithInstanceViewCallback = (error, result, request, response) => {
                if (error) {
                    return reject(tl.loc("VMDetailsFetchFailed", vmName, utils.getError(error)));
                }
                console.log(tl.loc("VMDetailsFetchSucceeded", vmName));
                resolve(result);
            }
            this.computeClient.virtualMachines.get(resourceGroupName, vmName, object, getVmWithInstanceViewCallback);
        });
    }

    private startVirtualMachine(vmName: string): Promise<any> {
        return new Promise((resolve, reject) => {
            this.computeClient.virtualMachines.start(this.taskParameters.resourceGroupName, vmName, async (error, result, request, response) => {
                if (error) {
                    console.log(utils.getError(error));
                    var isVMRunning = false;
                    try {
                        var vmWithInstanceView: az.VM = await this.getVmWithInstanceView(this.taskParameters.resourceGroupName, vmName, { expand: 'instanceView' });
                        var vmPowerState = this.getVMPowerState(vmWithInstanceView);
                        if (vmPowerState === "running") {
                            isVMRunning = true;
                        }
                    }
                    catch (exception) {
                        tl.warning(exception);
                    }
                    if (!isVMRunning) {
                        return reject(tl.loc("VMStartFailed", vmName, utils.getError(error)));
                    }
                }
                console.log(tl.loc("VMStarted", vmName));
                resolve(result);
            });
        });
    }

    private async tryDeleteFailedExtension(vm: az.VM) {
        try {
            await this.deleteExtensionFromSingleVM(vm);
        }
        catch (exception) {
            tl.warning(exception);
        }
    }

    private addExtensionOnRunningVm(vm: az.VM): Promise<any> {
        return new Promise((resolve, reject) => {
            var vmName = vm.name;
            var extensionParameters = this.formExtensionParameters(vm, "add");
            var extensionName = extensionParameters["extensionName"];
            var parameters = extensionParameters["parameters"];
            this.computeClient.virtualMachineExtensions.get(this.taskParameters.resourceGroupName, vmName, extensionName, null, async (error, result: az.VMExtension, request, response) => {
                if (result && result.properties.provisioningState === "Failed") {
                    await this.tryDeleteFailedExtension(vm);
                }
                console.log(tl.loc("AddExtension", extensionName, vmName));
                this.computeClient.virtualMachineExtensions.createOrUpdate(this.taskParameters.resourceGroupName, vmName, extensionName, parameters, async (error, result, request, response) => {
                    if (error) {
                        console.log(tl.loc("AddingExtensionFailed", extensionName, vmName, utils.getError(error)));
                        await this.tryDeleteFailedExtension(vm);
                        return reject(tl.loc("MGAgentOperationOnAllVMsFailed", "addition", ""));
                    }
                    console.log(tl.loc("AddingExtensionSucceeded", extensionName, vmName));
                    resolve();
                });
            });
        })
    }

    private formExtensionParameters(vm: az.VM, operation) {
        var vmId = vm.id;
        var vmName = vm.name;
        console.log("virtual machine : " + vmName);
        var vmOsType = vm.properties.storageProfile.osDisk.osType;
        console.log("Operating system on virtual machine : " + vmOsType);
        var vmLocation = vm.location;
        if (vmOsType === "Windows") {
            var extensionName = this.mgExtensionNameWindows;
            var virtualMachineExtensionType: string = this.vmExtensionTypeWindows;
            var typeHandlerVersion: string = this.version;
        }
        else if (vmOsType === "Linux") {
            extensionName = this.mgExtensionNameLinux;
            virtualMachineExtensionType = this.vmExtensionTypeLinux;
            typeHandlerVersion = this.version;
        }
        console.log(tl.loc("MGAgentHandlerMajorVersion", typeHandlerVersion.split(".")[0]));
        if (operation === "add") {
            var autoUpgradeMinorVersion: boolean = true;
            var publisher: string = this.publisher;
            var extensionType: string = this.extensionType;
            var collectionUri = this.taskParameters.machineGroupCollectionUrl;
            var teamProject = this.taskParameters.machineGroupProjectName;
            var uriLength = collectionUri.length;
            if (collectionUri[uriLength - 1] === '/') {
                collectionUri = collectionUri.substr(0, uriLength - 1);
            }
            var tags = "";
            if (vm.tags && this.taskParameters.copyAzureVMTags) {
                console.log("Copying VM tags")
                tags = vm.tags;
            }
            var publicSettings = {
                VSTSAccountName: collectionUri,
                TeamProject: teamProject,
                MachineGroup: this.taskParameters.machineGroupName,
                AgentName: "",
                Tags: tags
            };
            console.log("Public settings are:\n VSTSAccountName: %s\nTeamProject: %s\nMachineGroup: %s\nTags: %s\n", collectionUri, teamProject, this.taskParameters.machineGroupName, JSON.stringify(tags));
            var protectedSettings = { PATToken: this.taskParameters.vstsPATToken };
            var parameters = {
                type: extensionType,
                location: vmLocation,
                properties: {
                    publisher: publisher,
                    type: virtualMachineExtensionType,
                    typeHandlerVersion: typeHandlerVersion,
                    autoUpgradeMinorVersion: autoUpgradeMinorVersion,
                    settings: publicSettings,
                    protectedSettings: protectedSettings
                }
            };
        }
        return { vmName: vmName, extensionName: extensionName, parameters: parameters };
    }
}
