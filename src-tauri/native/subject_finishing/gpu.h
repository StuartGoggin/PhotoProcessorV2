#pragma once
#include "core.h"
#include "shaders.h"
#include <Windows.h>
#include <d3d11.h>
#include <d3dcompiler.h>
#include <dxgi1_2.h>
#include <wrl/client.h>
#include <cstring>
#include <string>

namespace subject_finishing {
using Microsoft::WRL::ComPtr;
inline void check(HRESULT result, const char* operation) {
    if (FAILED(result)) throw std::runtime_error(std::string(operation) + " failed (HRESULT " + std::to_string(uint32_t(result)) + ")");
}

class GpuSharpener {
    ComPtr<ID3D11Device> device;
    ComPtr<ID3D11DeviceContext> context;
    ComPtr<ID3D11ComputeShader> shader, colour;
    ComPtr<ID3D11Buffer> constants, colourConstants, input, maskInput, graded, output, readback;
    ComPtr<ID3D11ShaderResourceView> pictureView, gradedView, maskView;
    ComPtr<ID3D11UnorderedAccessView> outputView, gradedOutput;
    size_t allocatedPixels = 0;
public:
    DXGI_ADAPTER_DESC adapterDescription{};
    D3D_FEATURE_LEVEL featureLevel{};

    explicit GpuSharpener(uint32_t requiredVendor=0) {
        // Legacy callers retain the default hardware adapter. A requested vendor
        // is an explicit hardware requirement, never a software/CPU fallback.
        ComPtr<IDXGIAdapter1> selected;
        if(requiredVendor) {
            ComPtr<IDXGIFactory1> factory;
            check(CreateDXGIFactory1(IID_PPV_ARGS(&factory)), "Create vendor-selection factory");
            for(UINT index=0;index<16;++index) {
                ComPtr<IDXGIAdapter1> candidate;
                const HRESULT found=factory->EnumAdapters1(index,&candidate);
                if(found==DXGI_ERROR_NOT_FOUND)break;
                check(found,"Enumerate vendor adapter");
                DXGI_ADAPTER_DESC1 description{};
                check(candidate->GetDesc1(&description),"Describe vendor adapter");
                if(description.VendorId==requiredVendor&&!(description.Flags&DXGI_ADAPTER_FLAG_SOFTWARE)) {
                    selected=std::move(candidate);break;
                }
            }
            if(!selected)throw std::runtime_error("REQUIRED_GPU_VENDOR_UNAVAILABLE");
        }
        const auto driverType=selected?D3D_DRIVER_TYPE_UNKNOWN:D3D_DRIVER_TYPE_HARDWARE;
        constexpr D3D_FEATURE_LEVEL levels[] = {D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0};
        HRESULT result = D3D11CreateDevice(selected.Get(), driverType, nullptr, 0,
            levels, 2, D3D11_SDK_VERSION, &device, &featureLevel, &context);
        if (result == E_INVALIDARG) {
            result = D3D11CreateDevice(selected.Get(), driverType, nullptr, 0,
                levels+1, 1, D3D11_SDK_VERSION, &device, &featureLevel, &context);
        }
        check(result, "Create hardware D3D11 device");
        ComPtr<IDXGIDevice> dxgiDevice;
        ComPtr<IDXGIAdapter> adapter;
        check(device.As(&dxgiDevice), "Query DXGI device");
        check(dxgiDevice->GetAdapter(&adapter), "Get hardware adapter");
        check(adapter->GetDesc(&adapterDescription), "Get adapter description");
        if(requiredVendor&&adapterDescription.VendorId!=requiredVendor)
            throw std::runtime_error("REQUIRED_GPU_VENDOR_UNAVAILABLE");
        ComPtr<ID3DBlob> compiled, errors;
        result = D3DCompile(sharpenShader, std::strlen(sharpenShader), "subject-rgb709-q4-v2", nullptr, nullptr,
            "main", "cs_5_0", D3DCOMPILE_ENABLE_STRICTNESS | D3DCOMPILE_OPTIMIZATION_LEVEL3, 0, &compiled, &errors);
        if (FAILED(result) && errors) {
            throw std::runtime_error(std::string(static_cast<const char*>(errors->GetBufferPointer()), errors->GetBufferSize()));
        }
        check(result, "Compile subject sharpening shader");
        check(device->CreateComputeShader(compiled->GetBufferPointer(), compiled->GetBufferSize(), nullptr, &shader), "Create subject shader");
        D3D11_BUFFER_DESC descriptor{};
        descriptor.ByteWidth = 16;
        descriptor.Usage = D3D11_USAGE_DEFAULT;
        descriptor.BindFlags = D3D11_BIND_CONSTANT_BUFFER;
        check(device->CreateBuffer(&descriptor, nullptr, &constants), "Create recipe buffer");
        descriptor.ByteWidth = 48;
        check(device->CreateBuffer(&descriptor, nullptr, &colourConstants), "Create colour recipe buffer");
        compiled.Reset(); errors.Reset();
        result = D3DCompile(colourShader, std::strlen(colourShader), "subject-rgb709-colour-v1", nullptr, nullptr,
            "main", "cs_5_0", D3DCOMPILE_ENABLE_STRICTNESS | D3DCOMPILE_OPTIMIZATION_LEVEL3, 0, &compiled, &errors);
        if (FAILED(result) && errors) {
            throw std::runtime_error(std::string(static_cast<const char*>(errors->GetBufferPointer()), errors->GetBufferSize()));
        }
        check(result, "Compile subject colour shader");
        check(device->CreateComputeShader(compiled->GetBufferPointer(), compiled->GetBufferSize(), nullptr, &colour), "Create colour shader");
    }

    Frame filter(const Frame& source, const std::vector<uint8_t>& mask, Sharpness settings) {
        Finishing recipe;
        recipe.sharpness = settings;
        return filter(source, mask, recipe);
    }

    Frame filter(const Frame& source, const std::vector<uint8_t>& mask, Finishing settings) {
        validate_colour(settings.subject);
        validate_colour(settings.wholeFrame);
        const Sharpness sharpness = settings.sharpness;
        validate(source, mask, sharpness);
        allocate(source.pixels.size());
        std::vector<uint32_t> unpackedMask(mask.begin(), mask.end());
        const struct { uint32_t width, height; int32_t gain256, threshold16; } recipe{
            source.width, source.height, sharpness.gain256, sharpness.threshold16};
        context->UpdateSubresource(constants.Get(), 0, nullptr, &recipe, 0, 0);
        context->UpdateSubresource(input.Get(), 0, nullptr, source.pixels.data(), 0, 0);
        context->UpdateSubresource(maskInput.Get(), 0, nullptr, unpackedMask.data(), 0, 0);
        ID3D11ShaderResourceView* views[] = {pictureView.Get(), maskView.Get()};
        ID3D11UnorderedAccessView* unordered[] = {outputView.Get()};
        ID3D11Buffer* recipes[] = {constants.Get()};
        const bool gradeActive = !settings.subject.neutral() || (settings.wholeFrameEnabled && !settings.wholeFrame.neutral());
        if (gradeActive) {
            struct ColourValues {
                uint32_t width, height, enabled, reserved;
                Colour subject, wholeFrame;
            } values{source.width, source.height, settings.wholeFrameEnabled ? 1u : 0u, 0, settings.subject, settings.wholeFrame};
            static_assert(sizeof(ColourValues) == 48, "Colour shader constant contract");
            context->UpdateSubresource(colourConstants.Get(), 0, nullptr, &values, 0, 0);
            ID3D11Buffer* colourRecipe[] = {colourConstants.Get()};
            ID3D11UnorderedAccessView* gradeTarget[] = {gradedOutput.Get()};
            context->CSSetShader(colour.Get(), nullptr, 0);
            context->CSSetShaderResources(0, 2, views);
            context->CSSetConstantBuffers(0, 1, colourRecipe);
            context->CSSetUnorderedAccessViews(0, 1, gradeTarget, nullptr);
            context->Dispatch((source.width+15)/16, (source.height+15)/16, 1);
            ID3D11UnorderedAccessView* noTarget[] = {nullptr};
            context->CSSetUnorderedAccessViews(0, 1, noTarget, nullptr);
            views[0] = gradedView.Get();
        }
        context->CSSetShader(shader.Get(), nullptr, 0);
        context->CSSetShaderResources(0, 2, views);
        context->CSSetUnorderedAccessViews(0, 1, unordered, nullptr);
        context->CSSetConstantBuffers(0, 1, recipes);
        context->Dispatch((source.width+15)/16, (source.height+15)/16, 1);
        ID3D11UnorderedAccessView* noOutput[] = {nullptr};
        ID3D11ShaderResourceView* noInput[] = {nullptr, nullptr};
        context->CSSetUnorderedAccessViews(0, 1, noOutput, nullptr);
        context->CSSetShaderResources(0, 2, noInput);
        context->CopyResource(readback.Get(), output.Get());
        D3D11_MAPPED_SUBRESOURCE mapped{};
        check(context->Map(readback.Get(), 0, D3D11_MAP_READ, 0, &mapped), "Read finished GPU frame");
        Frame result{source.width, source.height, std::vector<Rgba>(source.pixels.size())};
        std::memcpy(result.pixels.data(), mapped.pData, result.pixels.size()*sizeof(Rgba));
        context->Unmap(readback.Get(), 0);
        return result;
    }
private:
    void allocate(size_t pixels) {
        if (allocatedPixels == pixels) return;
        input.Reset(); maskInput.Reset(); graded.Reset(); output.Reset(); readback.Reset();
        pictureView.Reset(); gradedView.Reset(); maskView.Reset(); outputView.Reset(); gradedOutput.Reset();
        D3D11_BUFFER_DESC descriptor{};
        descriptor.ByteWidth = UINT(pixels * sizeof(uint32_t));
        descriptor.Usage = D3D11_USAGE_DEFAULT;
        descriptor.MiscFlags = D3D11_RESOURCE_MISC_BUFFER_STRUCTURED;
        descriptor.StructureByteStride = 4;
        descriptor.BindFlags = D3D11_BIND_SHADER_RESOURCE;
        check(device->CreateBuffer(&descriptor, nullptr, &input), "Allocate source frame");
        check(device->CreateBuffer(&descriptor, nullptr, &maskInput), "Allocate subject mask");
        check(device->CreateShaderResourceView(input.Get(), nullptr, &pictureView), "Create picture view");
        check(device->CreateShaderResourceView(maskInput.Get(), nullptr, &maskView), "Create mask view");
        descriptor.BindFlags = D3D11_BIND_SHADER_RESOURCE | D3D11_BIND_UNORDERED_ACCESS;
        check(device->CreateBuffer(&descriptor, nullptr, &graded), "Allocate graded frame");
        check(device->CreateShaderResourceView(graded.Get(), nullptr, &gradedView), "Create graded view");
        check(device->CreateUnorderedAccessView(graded.Get(), nullptr, &gradedOutput), "Create graded target");
        descriptor.BindFlags = D3D11_BIND_UNORDERED_ACCESS;
        check(device->CreateBuffer(&descriptor, nullptr, &output), "Allocate finished frame");
        check(device->CreateUnorderedAccessView(output.Get(), nullptr, &outputView), "Create finished view");
        descriptor.Usage = D3D11_USAGE_STAGING;
        descriptor.BindFlags = 0;
        descriptor.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
        descriptor.MiscFlags = 0;
        descriptor.StructureByteStride = 0;
        check(device->CreateBuffer(&descriptor, nullptr, &readback), "Allocate readback frame");
        allocatedPixels = pixels;
    }
};
} // namespace subject_finishing
